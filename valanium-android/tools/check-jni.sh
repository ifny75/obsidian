#!/usr/bin/env bash
# Сверяет имена нативных методов Java с символами, которые экспортирует Rust.
#
# Расхождение здесь не ловит ни компилятор Java, ни компилятор Rust — оно
# вылезает UnsatisfiedLinkError уже на устройстве. Нужен только JDK.
#
#   tools/check-jni.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

javac -d "$work/classes" -h "$work/headers" \
    "$root/app/src/main/java/app/valanium/core/Core.java" \
    "$root/app/src/main/java/app/valanium/core/Commands.java"

header="$work/headers/app_valanium_core_Core.h"
symbols() { grep -o 'Java_app_valanium_core_Core_[a-zA-Z]*' "$1" | sort -u; }

symbols "$header" > "$work/java.txt"
symbols "$root/rust/src/lib.rs" > "$work/rust.txt"

echo "Java объявляет:"
sed 's/^/  /' "$work/java.txt"
echo "Rust экспортирует:"
sed 's/^/  /' "$work/rust.txt"
echo

if diff -q "$work/java.txt" "$work/rust.txt" > /dev/null; then
    echo "имена сходятся"
else
    echo "РАСХОЖДЕНИЕ — на устройстве будет UnsatisfiedLinkError:"
    diff "$work/java.txt" "$work/rust.txt" || true
    exit 1
fi

# Сигнатуры сверяются глазами: их четыре, и меняются они раз в год.
echo
echo "Сигнатуры из javac -h (должны совпадать с lib.rs):"
grep -A2 'JNIEXPORT' "$header" | grep -v '^--' | sed 's/  */ /g' | sed 's/^/  /'
