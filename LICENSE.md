All Reports in this Repository are licensed by Contributors
under the
[W3C Software and Document License](https://www.w3.org/copyright/software-license/).

Contributions to Specifications are made under the
[W3C CLA](https://www.w3.org/community/about/process/cla/).

Contributions to Test Suites are made under the
[W3C 3-clause BSD License](https://www.w3.org/copyright/3-clause-bsd-license-2008/)

## Exception: the Public Hash List

The [`public-hash-list/`](public-hash-list/) directory is licensed under the
[Apache License 2.0](public-hash-list/LICENSE) instead. That covers both the
generator implementation and the generated list data.

The list is meant to be consumed directly by user agents, so it is licensed on
the terms browser engines already vendor third-party data under, rather than on
terms written for specifications and reports. Apache-2.0 is on the license
allowlists that shipping browsers apply to bundled dependencies; the W3C
Software and Document License is not, which would otherwise block adoption of
the very artifact the list exists to provide.

Nothing else in this repository is affected: the specification, the explainers
and the implementation notes remain under the terms above.
