import Darwin
import Foundation

guard CommandLine.arguments.count == 4 else {
  fputs("usage: atomic-swap-mac.swift --exchange|--rename source target\n", stderr)
  exit(2)
}
let operation = CommandLine.arguments[1]
let source = CommandLine.arguments[2]
let target = CommandLine.arguments[3]
let status: Int32
if operation == "--exchange" {
  status = renamex_np(source, target, UInt32(RENAME_SWAP))
} else if operation == "--rename" {
  status = rename(source, target)
} else {
  fputs("unsupported atomic rename operation\n", stderr)
  exit(2)
}
if status != 0 {
  let message = String(cString: strerror(errno))
  fputs("atomic rename failed: \(message)\n", stderr)
  exit(1)
}
