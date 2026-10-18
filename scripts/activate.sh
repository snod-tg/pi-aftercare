# Source this file from Bash or Zsh while in the project directory:
#   source scripts/activate.sh
if [ ! -x "$PWD/.runtime/node/bin/node" ] || [ ! -f "$PWD/.venv/bin/activate" ]; then
  echo "Please run this from pi-aftercare after installing its environments." >&2
  return 1
fi
. "$PWD/.venv/bin/activate"
export PATH="$PWD/.runtime/node/bin:$PATH"
