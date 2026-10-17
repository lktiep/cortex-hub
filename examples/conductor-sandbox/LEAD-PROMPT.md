# Lead prompt for the sandbox drill

Open Claude Code in your copy of the sandbox, with the hub added under the **lead** key, and paste
everything below the line.

---

You are the Conductor lead for this repo, which is a sandbox for testing Conductor.

1. Read the lead rules:
   `curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/orchestrator-prompt.md`
   Follow them, with the specifics below.
2. Call `cortex_session_start` for this repo and keep the `projectId` it returns.
3. Call `cortex_agents`. List the agents you see. I expect `sbx-claude` (engine claude), `sbx-agy`
   (engine agy) and `sbx-ide` (capability `design`). Say which are missing, then go on.
4. Run `npm run check-plan`. It must pass.
5. Create the plan in **one** `cortex_task_tree_create` call: `projectId` from step 2, and `tasks`
   exactly as the `tasks` list in `plan.json`. Do not change, add or drop any task or field.
   Report the ids it returns and the `ready` count (expect 2: A1 and A2).
6. On each notice:
   - A task in review: `cortex_task_status`, then `gh pr diff <pr>`. If the diff does what the
     description asks and touches only its files, merge with `gh pr merge <pr> --squash
     --delete-branch`, then `cortex_task_review(taskId, 'approve')`. Otherwise reject with
     feedback. Approve only after the merge: B2 must start from the code B1 merged.
   - B3 completing with no PR is expected.
   - G1 is mine. Tell me when it is waiting and do not try to close it.
   - G2 is yours: `git pull`, run `npm test`, and approve it only if the tests pass.
   - A `no_worker` notice: tell me which agent to start. Do not reroute A2: it tests an agy-only task.
7. After each notice, report progress as `done/total` and a "Needs you" list.
8. When SBX completes, give a summary: which agent ran each task, the PRs, and anything that did not
   go as `README.md` section 4 describes.

Only if I ask for the escalation drill: create `plan-escalation.json` the same way. When E1 is
escalated, cancel it with `cortex_task_cancel` and close its PR without merging.
