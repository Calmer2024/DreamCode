use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
    SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, OWNER_SECURITY_INFORMATION,
    SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW};
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
unsafe fn show_sd(handle: *mut std::ffi::c_void) {
    unsafe {
        let mut descriptor = null_mut();
        let status = GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            println!("GetSecurityInfo error={status}");
            return;
        }
        let mut text = null_mut();
        if ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            1,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut text,
            null_mut(),
        ) != 0
        {
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            println!(
                "SDDL={}",
                String::from_utf16_lossy(std::slice::from_raw_parts(text, len))
            );
            LocalFree(text as _);
        }
        LocalFree(descriptor);
    }
}
fn main() {
    unsafe {
        let custom = std::env::var("DC_PIPE_SDDL").ok();
        let repair = std::env::var("DC_PIPE_REPAIR").is_ok();
        let mut descriptor = null_mut();
        if let Some(sddl) = &custom {
            assert!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(sddl).as_ptr(),
                    1,
                    &mut descriptor,
                    null_mut()
                ) != 0
            );
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        for access in [0x80000000u32, 0x40000000, 0xc0000000, 0x40000, 0xc0040000] {
            let name = wide(&format!(
                "\\\\.\\pipe\\dcv2-debug-{}-{access}",
                std::process::id()
            ));
            let server = CreateNamedPipeW(
                name.as_ptr(),
                3 | 0x40000,
                0,
                1,
                65536,
                65536,
                0,
                if custom.is_some() && !repair {
                    &attributes
                } else {
                    null()
                },
            );
            if server == INVALID_HANDLE_VALUE {
                println!("server access={access:x} error={}", GetLastError());
                continue;
            }
            if repair {
                let mut present = 0;
                let mut defaulted = 0;
                let mut dacl = null_mut();
                assert!(
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
                        != 0
                        && present != 0
                        && !dacl.is_null()
                );
                let status = SetSecurityInfo(
                    server,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null_mut(),
                );
                println!("repair status={status}");
            }
            show_sd(server);
            let client = CreateFileW(name.as_ptr(), access, 0, null(), 3, 0, null_mut());
            if client == INVALID_HANDLE_VALUE {
                println!("client access={access:x} error={}", GetLastError());
            } else {
                println!("ok access={access:x}");
                if access & 0xc0000000 == 0xc0000000 {
                    let connected = ConnectNamedPipe(server, null_mut());
                    assert!(connected != 0 || GetLastError() == 535);
                    let mut written = 0;
                    let mut read = 0;
                    let mut buffer = [0u8; 4];
                    assert!(WriteFile(client, b"ping".as_ptr(), 4, &mut written, null_mut()) != 0);
                    assert!(ReadFile(server, buffer.as_mut_ptr(), 4, &mut read, null_mut()) != 0);
                    assert_eq!(&buffer, b"ping");
                    assert_eq!(read, 4);
                    assert_eq!(written, 4);
                    assert!(WriteFile(server, b"pong".as_ptr(), 4, &mut written, null_mut()) != 0);
                    assert!(ReadFile(client, buffer.as_mut_ptr(), 4, &mut read, null_mut()) != 0);
                    assert_eq!(&buffer, b"pong");
                    println!("roundtrip=ping/pong");
                }
                CloseHandle(client);
            }
            CloseHandle(server);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor);
        }
        if let Ok(outside) = std::env::var("DC_BOUNDARY_FILE") {
            match std::fs::write(outside, "escaped") {
                Ok(()) => {
                    println!("ERROR: outside file write allowed");
                    std::process::exit(3);
                }
                Err(error) => println!("outside file write denied={error}"),
            }
        }
    }
}
