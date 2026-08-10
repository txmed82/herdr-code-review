# Herdr Code Review

Launch a structured AI code review from the focused Herdr pane.

The plugin collects staged and unstaged Git changes, opens a review pane, runs a non-interactive reviewer, prints the findings there, and sends the final review back to the source pane.

## Install

```sh
herdr plugin install txmed82/herdr-code-review
```

## Actions

```sh
herdr plugin action invoke review-split --plugin herdr-code-review
herdr plugin action invoke review-tab --plugin herdr-code-review
```

## Keybindings

```toml
[[keys.command]]
key = "ctrl+shift+r"
type = "plugin_action"
command = "herdr-code-review.review-split"
description = "Code Review: review current worktree in split"

[[keys.command]]
key = "ctrl+shift+t"
type = "plugin_action"
command = "herdr-code-review.review-tab"
description = "Code Review: review current worktree in tab"
```

## Configuration

By default the plugin uses:

```sh
omp -p --model opencode-go/glm-5.2:high @prompt.md
```

Override the model:

```sh
export HERDR_REVIEW_MODEL="gpt-5.2"
```

Override the whole command:

```sh
export HERDR_REVIEW_COMMAND='codex exec --cd "$HERDR_REVIEW_CWD" --skip-git-repo-check - < "$HERDR_REVIEW_PROMPT_PATH"'
```

Disable sending the review back to the source pane:

```sh
export HERDR_REVIEW_SEND_BACK=0
```

Increase the diff budget:

```sh
export HERDR_REVIEW_MAX_CHARS=60000
```

## Development

```sh
npm test
herdr plugin link .
```
