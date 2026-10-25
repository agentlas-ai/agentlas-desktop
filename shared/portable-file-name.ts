// A file name every desktop OS accepts. Windows rejects < > : " / \ | ? * and control characters, a
// trailing dot or space, and the device names CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with any extension).
// Windows audit 2026-10-24: a default save name built from a title like `보고서: 3분기?` was refused by the
// save dialog (ui.md #17), and a phone attachment named `report?.pdf` or `con.txt` failed to
// materialize or produced a file Explorer cannot delete (fs.md #21). One rule for every OS, so a name
// chosen on a Mac also works when the same project is opened on Windows.

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

export function portableFileName(value: string, fallback = "file", maxLength = 180): string {
  let name = String(value ?? "").normalize("NFC").replace(FORBIDDEN, "-");
  name = name.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (!name) name = fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > maxLength) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = `${name.slice(0, maxLength - ext.length).replace(/[\s.]+$/, "")}${ext}`;
  }
  return name;
}
