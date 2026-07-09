# How to contribute

We'd love to accept your patches and contributions to this project.

## Before you begin

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about) (CLA).
You (or your employer) retain the copyright to your contribution; this simply
gives us permission to use and redistribute your contributions as part of the
project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or to
sign a new one.

### Review our community guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google/conduct/).

## Contribution process

### Code reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.

## Building the spec

The formal specification lives in [`index.bs`](index.bs) and is written for
[Bikeshed](https://speced.github.io/bikeshed/). To build it locally:

```sh
pip install bikeshed && bikeshed update
bikeshed spec index.bs index.html
```

On every push to `main`, [a GitHub Action](.github/workflows/build.yml) builds
`index.bs` and commits the resulting `index.html` back to `main`, which
[GitHub Pages](https://wicg.github.io/cross-origin-storage/) serves directly.
Pull requests only build and validate `index.bs`; they do not commit anything.
