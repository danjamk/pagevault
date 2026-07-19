# Remote image reference — export test

This document tests how PageVault handles a **remote image** — one loaded from an
absolute `https://` URL rather than bundled into the file.

The image below is the PageVault wordmark, served from this repository over GitHub's
raw host:

![PageVault wordmark](https://raw.githubusercontent.com/danjamk/pagevault/main/docs/brand/wordmark.png)

## What to expect

- **In the interactive viewer** the image loads. The sandbox CSP allows images from any
  `https:` host (`img-src data: blob: https:`), so a remote reference resolves.
- **In a PDF export** the image is missing. The PDF renderer ([#50](https://github.com/danjamk/pagevault/issues/50))
  aborts every outbound request during the render — a hostile artifact must not be able to
  phone home — so nothing fetched from the network survives into the PDF. Only images inlined
  as `data:` URIs render in a PDF.

That gap is deliberate, not a defect: the interactive view is full fidelity; the PDF trades
remote assets for the guarantee that the render never touches the network.

A **relative** reference — `![](docs/brand/wordmark.png)` — would 404 in both views, because
PageVault hosts one file with no companion assets. An absolute URL is the only kind of remote
reference that can work, and only in the interactive view.
