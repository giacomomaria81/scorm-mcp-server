# Privacy Policy — scorm-mcp-server

*Last updated: July 18, 2026*

**scorm-mcp-server is a local tool. It does not collect, store, or transmit any personal data.**

## What the extension does with your data

- All processing happens **locally on your computer**: the HTML you provide is read, converted, and written as a SCORM `.zip` package into the output folder **you** configure. Nothing is uploaded anywhere by the extension.
- **No analytics, no telemetry, no accounts.** The extension has no backend and phones home to no one.

## Network access

The only network activity the extension may perform is **downloading assets that your own HTML references** (images, stylesheets, scripts, fonts hosted on the web) in order to embed them into the offline package. These requests go directly to the servers referenced by your document — chosen by you, not by us — and contain no personal data beyond the standard HTTP request itself. If your HTML references only local files, the extension performs **zero** network requests.

## File access

- **Read**: the HTML file you point it to (`input_path`) and assets located **inside that file's folder**. References outside the module folder are refused by design (and reported as warnings).
- **Write**: the generated `.zip` package, into the output directory you configured.

## Third parties

None. No data is shared with third parties. The generated SCORM package belongs to you; what an LMS does with learner tracking data once *you* upload the package there is governed by that LMS's own privacy policy.

## Contact

Questions: open an issue on the GitHub repository.
