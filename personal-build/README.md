# Personal application source backup

`source-0.63.1-personal.17.zip` preserves the exact `src/` directory and `package.json` of the personal Windows application. Its manifest lists each file's SHA-256. The archive contains source only. It excludes user data, credentials, local logs, dependencies and native binaries.

The normal source tree contains the cloud-usage and memory fixes with their tests. The source archive additionally preserves the existing personal presentation and window behavior, which differ from the upstream checkout. Extract it into a separate checkout when inspecting that variant; do not overwrite uncommitted work.

This is a source backup, not a Windows installer. The measured application uses Electron 43.4.0. Existing native dependencies were unchanged. The sanitized memory report in `docs/verification/2026-10-31-personal-memory.md` records the validation scope and results.
