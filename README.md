# Walkthrough skills

Agent skills for turning code and working applications into narrated walkthroughs.
Each produces an **MP4 video with SRT captions**, a **standalone HTML page**, and a
**Markdown summary**, collected in one folder per walkthrough.

 - [Feature Walkthrough example.](https://emarc.github.io/prototypes/feature-walkthrough/)
 - [Code Walkthrough example.](https://emarc.github.io/prototypes/code-walkthrough/)


| Skill | What it does | Typical uses |
| --- | --- | --- |
| [code-walkthrough](code-walkthrough/SKILL.md) | Explains code and changes through highlighted code, diffs, diagrams, and before/after UI comparisons. | PR reviews, explaining a changeset, developer onboarding, understanding an API or architecture. |
| [feature-walkthrough](feature-walkthrough/SKILL.md) | Drives a running app in a browser and narrates the workflow, with screenshots for the written versions. | Feature demos, release walkthroughs, onboarding, showing how to complete a task. |

## Example requests

Point the agent at a local repository, commit, branch comparison, uncommitted
changes, or a GitHub PR (by URL or number in the current repository). 

If you are in your project, you can be super concise
```text
/code-walkthrough #123
/feature-walkthrough last commit
```

Or you can tell it a bit more, what to focus on:

```text
/code-walkthrough Explain my uncommitted changes and why they matter.
/code-walkthrough Walk through feature/search compared with main.
/code-walkthrough Explain https://github.com/OWNER/REPO/pull/123 for a reviewer.
/code-walkthrough Show how authentication is wired in this repository.

/feature-walkthrough Demo the user-visible changes in the last commit.
/feature-walkthrough Demo the workflow introduced by PR #123.
```

For a feature walkthrough, you can also provide **any reachable running app or
URL** and describe what to demonstrate; a changeset is optional:

```text
/feature-walkthrough At http://localhost:3000, show creating a project and inviting a teammate.
/feature-walkthrough At https://app.example.com, demo searching, filtering, and exporting results.
```

For GitHub changes, the agent can use `gh` to inspect the PR and fetch the relevant
code. Code walkthroughs render from a local checkout. Feature walkthroughs need a
running app with the behavior you want to show; provide login and test-data details
when needed.

## Repository layout

Each skill is a self-contained directory with its own `SKILL.md` and supporting
scripts. Share or install those directories as skills. This top-level README is
the repository overview; see each skill's instructions for setup and dependencies.
