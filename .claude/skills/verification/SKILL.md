---
name: verification
description: Verify completion claims against actual tool outputs before reporting done
---

# Step Verification Protocol

Before claiming ANY work is complete, verify your claims against actual tool outputs.

## Mandatory Checks

### "Tests pass" claim
Before saying tests pass, verify:
- [ ] You actually ran a test command (`npm test`, `npx vitest`, `pytest`, `cargo test`, `go test`)
- [ ] The test output does NOT contain `FAIL`, `FAILED`, `ERROR`, `AssertionError`, or non-zero exit code
- [ ] If you didn't run tests, say "tests not run" not "tests pass"

### "File created/modified" claim
Before saying you created or modified a file:
- [ ] You actually used `Write` or `Edit` tool (not just described what you'd write)
- [ ] Read the file back to confirm it contains what you expect

### "Committed/pushed" claim
Before saying you committed or pushed:
- [ ] You ran `git commit` (check exit code)
- [ ] You ran `git push` (check exit code, look for rejection errors)
- [ ] Run `git status` to confirm clean working tree

### "Build succeeds" claim
Before saying the build passes:
- [ ] You ran the build command (`npm run build`, `tsc`, `cargo build`, `go build`)
- [ ] The output does NOT contain errors
- [ ] Exit code was 0

## Verification Process
1. After completing work, list what you claim to have accomplished
2. For EACH claim, check the tool output that proves it
3. If any claim can't be verified, either:
   - Run the verification command now
   - Retract the claim and say what actually happened

## Red Flags (things that should trigger re-verification)
- "I believe tests should pass" → you didn't run them
- "The file should contain..." → you didn't read it back
- "This should work" → you didn't test it
- Claiming success after a fix without re-running verification
