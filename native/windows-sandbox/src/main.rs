#![cfg(windows)]

use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::process::{Command, ExitCode};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, SE_FILE_OBJECT, SET_ACCESS,
    SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, ACL_REVISION, AddAccessAllowedAce, CreateRestrictedToken, DACL_SECURITY_INFORMATION,
    DISABLE_MAX_PRIVILEGE, GetLengthSid, InitializeAcl, LUA_TOKEN, SID_AND_ATTRIBUTES,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_QUERY, TokenDefaultDacl,
    WRITE_RESTRICTED,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, INFINITE,
    OpenProcessToken, PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, WaitForSingleObject,
};

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn quote(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.into();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(ch);
        }
        slashes = 0;
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn fail(message: &str) -> ! {
    eprintln!("DreamCode sandbox: {message} (win32={})", unsafe {
        GetLastError()
    });
    std::process::exit(125)
}

unsafe fn grant_writable_root(root: &str, sid: *mut c_void) -> Result<(), u32> {
    let mut root_wide = wide(root);
    let mut old_dacl: *mut ACL = null_mut();
    let mut descriptor: *mut c_void = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            root_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(status);
    }
    let trustee = TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    };
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: 0x10000000,
        grfAccessMode: SET_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: trustee,
    };
    let mut new_dacl: *mut ACL = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, old_dacl, &mut new_dacl) };
    if status == 0 {
        let set_status = unsafe {
            SetNamedSecurityInfoW(
                root_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            )
        };
        unsafe {
            LocalFree(new_dacl as *mut c_void);
            LocalFree(descriptor);
        }
        if set_status != 0 {
            return Err(set_status);
        }
        Ok(())
    } else {
        unsafe {
            LocalFree(descriptor);
        }
        Err(status)
    }
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let split = raw
        .iter()
        .position(|v| v == "--")
        .unwrap_or_else(|| fail("missing command separator"));
    let (options, command) = raw.split_at(split);
    let command = &command[1..];
    if command.is_empty() {
        fail("missing command");
    }
    let mut cwd = None;
    let mut mode = String::from("read-only");
    let mut capability_sid = None;
    let mut roots = Vec::new();
    let mut i = 0;
    while i < options.len() {
        match options[i].as_str() {
            "--cwd" => {
                i += 1;
                cwd = options.get(i).cloned();
            }
            "--writable-root" => {
                i += 1;
                if let Some(v) = options.get(i) {
                    roots.push(v.clone());
                }
            }
            "--mode" => {
                i += 1;
                if let Some(v) = options.get(i) {
                    mode = v.clone();
                }
            }
            "--capability-sid" => {
                i += 1;
                capability_sid = options.get(i).cloned();
            }
            other => {
                eprintln!("DreamCode sandbox: unknown option {other}");
                return ExitCode::from(125);
            }
        }
        i += 1;
    }
    if mode != "read-only" && mode != "workspace-write" {
        fail("invalid managed sandbox mode");
    }
    if mode == "read-only" && !roots.is_empty() {
        fail("read-only mode cannot accept writable roots");
    }

    let sid_text = capability_sid.unwrap_or_else(|| fail("missing capability SID"));
    let logon_output = Command::new("whoami.exe")
        .arg("/logonid")
        .output()
        .unwrap_or_else(|_| fail("whoami /logonid failed"));
    let logon_sid_text = String::from_utf8_lossy(&logon_output.stdout)
        .trim()
        .to_string();
    if !logon_output.status.success() || !logon_sid_text.starts_with("S-1-5-5-") {
        fail("could not resolve the logon SID");
    }
    unsafe {
        let mut sid: *mut c_void = null_mut();
        if ConvertStringSidToSidW(wide(&sid_text).as_ptr(), &mut sid) == 0 {
            fail("invalid sandbox SID");
        }
        for root in &roots {
            if let Err(code) = grant_writable_root(root, sid) {
                eprintln!("DreamCode sandbox: could not grant sandbox ACL on {root} (win32={code})");
                return ExitCode::from(125);
            }
        }
        let mut logon_sid: *mut c_void = null_mut();
        if ConvertStringSidToSidW(wide(&logon_sid_text).as_ptr(), &mut logon_sid) == 0 {
            fail("invalid logon SID");
        }
        let mut everyone_sid: *mut c_void = null_mut();
        if ConvertStringSidToSidW(wide("S-1-1-0").as_ptr(), &mut everyone_sid) == 0 {
            fail("invalid Everyone SID");
        }
        let mut base: HANDLE = null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut base,
        ) == 0
        {
            fail("OpenProcessToken failed");
        }
        let mut restricting = [
            SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: logon_sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: everyone_sid,
                Attributes: 0,
            },
        ];
        let mut token: HANDLE = null_mut();
        if CreateRestrictedToken(
            base,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            null(),
            0,
            null(),
            restricting.len() as u32,
            restricting.as_mut_ptr(),
            &mut token,
        ) == 0
        {
            fail("CreateRestrictedToken failed");
        }

        // New securable objects must grant the restricting SIDs as well as the normal token SIDs.
        let sid_length = GetLengthSid(sid) + GetLengthSid(logon_sid) + GetLengthSid(everyone_sid);
        let mut acl_storage =
            vec![0u8; (std::mem::size_of::<ACL>() as u32 + 128 + sid_length) as usize];
        let acl = acl_storage.as_mut_ptr() as *mut ACL;
        if InitializeAcl(acl, acl_storage.len() as u32, ACL_REVISION) == 0 {
            fail("InitializeAcl failed");
        }
        if AddAccessAllowedAce(acl, ACL_REVISION, 0x10000000, sid) == 0 {
            fail("AddAccessAllowedAce failed");
        }
        if AddAccessAllowedAce(acl, ACL_REVISION, 0x10000000, logon_sid) == 0 {
            fail("AddAccessAllowedAce failed");
        }
        if AddAccessAllowedAce(acl, ACL_REVISION, 0x10000000, everyone_sid) == 0 {
            fail("AddAccessAllowedAce failed");
        }
        let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        if SetTokenInformation(
            token,
            TokenDefaultDacl,
            &default_dacl as *const _ as *const c_void,
            std::mem::size_of_val(&default_dacl) as u32,
        ) == 0
        {
            fail("SetTokenInformation failed");
        }

        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            fail("CreateJobObject failed");
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            fail("SetInformationJobObject failed");
        }

        let line = command
            .iter()
            .map(|v| quote(v))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command_line = wide(&line);
        let cwd_wide = cwd.as_deref().map(wide);
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessAsUserW(
            token,
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED,
            null(),
            cwd_wide.as_ref().map_or(null(), |v| v.as_ptr()),
            &startup,
            &mut process,
        ) == 0
        {
            fail("CreateProcessAsUser failed");
        }
        if AssignProcessToJobObject(job, process.hProcess) == 0 {
            fail("AssignProcessToJobObject failed");
        }
        ResumeThread(process.hThread);
        let wait = WaitForSingleObject(process.hProcess, INFINITE);
        if wait == 0xFFFF_FFFF {
            fail("WaitForSingleObject failed");
        }
        let mut code = 1u32;
        if GetExitCodeProcess(process.hProcess, &mut code) == 0 {
            fail("GetExitCodeProcess failed");
        }
        if code > 255 {
            eprintln!("DreamCode sandbox: child exited with Windows status 0x{code:08X}");
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        CloseHandle(token);
        CloseHandle(base);
        LocalFree(sid);
        LocalFree(logon_sid);
        LocalFree(everyone_sid);
        ExitCode::from((code.min(255)) as u8)
    }
}
