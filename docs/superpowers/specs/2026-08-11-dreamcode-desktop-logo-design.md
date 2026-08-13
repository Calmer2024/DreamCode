# DreamCode Desktop Logo Design

## Goal

Use `C:\Users\28109\Pictures\logo-dreamcode.png` as the Windows desktop application and
distribution icon without changing the logo artwork.

## Asset Processing

- Copy the source PNG into the desktop package's build assets.
- Remove only white or near-white pixels connected to the image canvas edge, making the exterior
  background transparent while preserving all enclosed white logo details.
- Keep the square composition and original color treatment.
- Generate a Windows ICO containing 16, 24, 32, 48, 64, 128, and 256 pixel images.

## Packaging Integration

- Configure Electron Builder's Windows application icon to use the generated ICO.
- Use the same ICO for the NSIS installer and uninstaller.
- The portable executable inherits the Windows application icon.
- Package both the existing x64 NSIS installer and portable executable under
  `packages/desktop/release`.

## Verification

- Confirm the derived PNG has an alpha channel and transparent corners.
- Confirm the ICO contains the expected sizes.
- Run lint, typecheck, desktop build, Windows packaging, packaged chain test, and checksums.
- Inspect the produced executables and provide the absolute installer path for manual acceptance.

## Scope

No UI layout, runtime behavior, branding colors, package names, version numbers, or application
capabilities change as part of this work.
