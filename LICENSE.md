All Reports in this Repository are licensed by Contributors
under the
[W3C Software and Document License](https://www.w3.org/copyright/software-license/).

Contributions to Specifications are made under the
[W3C CLA](https://www.w3.org/community/about/process/cla/).

Contributions to Test Suites are made under the
[W3C 3-clause BSD License](https://www.w3.org/copyright/3-clause-bsd-license-2008/)

## Exception: the Public Hash List implementation and data

The [`public-hash-list/implementation/`](public-hash-list/implementation/)
directory is licensed under the
[Apache License 2.0](public-hash-list/implementation/LICENSE) instead, per that
directory's own `LICENSE` file. That covers the generator tooling and the list
data it produces.

Those are consumed as software and data rather than read as a report: browsers
vendor the generated list as a third-party dependency, and Apache-2.0 is on the
license allowlists engines apply to bundled dependencies, where neither the W3C
Software and Document License nor the MPL-2.0 this previously used appears.

Everything else remains under the terms above, including
[`public-hash-list/phl-explainer.md`](public-hash-list/phl-explainer.md), which
is a report like the other explainers here.
