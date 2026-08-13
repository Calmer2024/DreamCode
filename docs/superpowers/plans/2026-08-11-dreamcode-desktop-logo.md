# DreamCode Desktop Logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved DreamCode PNG logo to the Windows application, NSIS installer, uninstaller, and portable executable, then provide a freshly verified installer for acceptance.

**Architecture:** Derive project-owned build assets from the supplied square PNG using deterministic Pillow processing. Only the edge-connected near-white exterior becomes transparent; enclosed white logo details remain opaque. Electron Builder consumes a multi-resolution ICO from `packages/desktop/build` for every Windows distribution target.

**Tech Stack:** Python Pillow, Electron Builder 26.15.3, PowerShell, Windows x64.

## Global Constraints

- Use `C:\Users\28109\Pictures\logo-dreamcode.png` as the source artwork.
- Do not alter the logo subject, colors, proportions, or enclosed white details.
- Remove only white or near-white pixels connected to the image canvas edge.
- Generate ICO sizes 16, 24, 32, 48, 64, 128, and 256 pixels.
- Keep the existing product name, version, NSIS per-user target, and portable x64 target.
- Do not change runtime behavior or UI layout.

---

### Task 1: Derive Windows Icon Assets and Repackage

**Files:**
- Create: `packages/desktop/build/logo-dreamcode.png`
- Create: `packages/desktop/build/icon.ico`
- Modify: `packages/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: `C:\Users\28109\Pictures\logo-dreamcode.png` and Electron Builder's `win.icon`, `nsis.installerIcon`, `nsis.uninstallerIcon`, and `nsis.installerHeaderIcon` settings.
- Produces: transparent project PNG, multi-resolution Windows ICO, and freshly packaged setup/portable executables.

- [ ] **Step 1: Record the current packaging warning**

Run:

```powershell
pnpm desktop:dist
```

Expected: packaging succeeds but reports `default Electron icon is used`, proving the custom icon is not yet configured.

- [ ] **Step 2: Derive the transparent PNG and ICO**

Use Pillow to load the source as RGBA, flood-fill from all canvas-edge near-white pixels with a tolerance that includes the white background but does not cross the purple/blue logo boundary, set only that connected region's alpha to zero, and save the result as `packages/desktop/build/logo-dreamcode.png`.

Save `packages/desktop/build/icon.ico` from the processed image with these embedded square sizes:

```text
16, 24, 32, 48, 64, 128, 256
```

- [ ] **Step 3: Validate the derived bitmap assets**

Run a Pillow inspection that asserts:

```python
png.mode == "RGBA"
png.getpixel((0, 0))[3] == 0
png.getpixel((png.width - 1, png.height - 1))[3] == 0
ico.ico.sizes() == {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)}
```

Expected: all assertions pass; the source artwork remains unchanged.

- [ ] **Step 4: Configure Electron Builder**

Add the build resources directory and Windows/NSIS icon settings:

```yaml
directories:
  buildResources: build
  output: release
win:
  icon: build/icon.ico
nsis:
  installerIcon: build/icon.ico
  uninstallerIcon: build/icon.ico
  installerHeaderIcon: build/icon.ico
```

- [ ] **Step 5: Run repository and packaging verification**

Run in order:

```powershell
pnpm lint
pnpm typecheck
pnpm --filter @dreamcode/desktop build
pnpm desktop:dist
pnpm --filter @dreamcode/desktop chain-test
pnpm --filter @dreamcode/desktop checksums
```

Expected: every command exits `0`; Electron Builder no longer reports the default-icon warning; the packaged chain report passes.

- [ ] **Step 6: Inspect acceptance artifacts**

Run:

```powershell
Get-ChildItem packages\desktop\release\DreamCode-Setup-0.1.0-x64.exe,
  packages\desktop\release\DreamCode-Portable-0.1.0-x64.exe |
  Select-Object FullName,Length,LastWriteTime
Get-Content packages\desktop\release\SHA256SUMS.txt
Get-Content packages\desktop\release\chain-test-report.json
```

Expected: both executables are non-empty and freshly timestamped; hashes and chain report match the new artifacts.

- [ ] **Step 7: Commit**

```powershell
git add packages/desktop/build packages/desktop/electron-builder.yml
git commit -m "build(desktop): apply DreamCode application icon"
```
