# create-spicyspec

`npx create-spicyspec my-project` — scaffolds a project a team member can run in five
commands: runner config, a sample feature catalog, a README, `.gitignore`, and the state
directories. It refuses to write into a non-empty directory.

The scaffolded `spicyspec.runner.json` ships a `supervise` block, so
`spicyspec-runner install-autostart --config spicyspec.runner.json` works the minute the
project exists — see the generated README's "Leave it running overnight" section, and
[docs/dev-setup.md](../../docs/dev-setup.md#boot-survival-which-of-the-two-and-why).

## Building

Run `nx build create-spicyspec` to build the library.

## Running unit tests

Run `nx test create-spicyspec` to execute the unit tests via [Vitest](https://vitest.dev/).
