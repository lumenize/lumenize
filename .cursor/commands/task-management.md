# Task Management Command

Manage project tasks using the tasks/ directory system.

## Usage

`/task-management <action> <task-name>`

Actions: `create`, `update`, `complete`

## Description

Lumenize uses task files in the `tasks/` directory to track work. This command helps manage those task files following project conventions.

## Task Types

### Small Tasks (`tasks/backlog.md`)
- Standalone tasks
- Can be completed in one session
- No multiple phases

### Multi-Phase Projects (`tasks/[project-name].md`)
- Complex projects with phases and steps
- Detailed plans and design decisions
- Multiple work sessions

### Decisions (`tasks/decisions/`)
- Research findings
- Technical decisions
- Architecture choices

### Completed (`tasks/archive/`)
- Finished projects
- Kept for reference

## Steps

### Creating a New Task

1. **Human** describes the task or project
2. **AI agent** determines if it's a small task or multi-phase project
3. **AI agent** creates appropriate file:
   - Small task: Add to `tasks/backlog.md`
   - Multi-phase: Create `tasks/[project-name].md` with phases
4. **AI agent** structures the task file with:
   - Clear objective/goal
   - Phases (if multi-phase)
   - Steps within each phase
   - Success criteria
5. **Human** reviews and approves the task plan

### Updating an Existing Task

1. **Human** identifies task to update and explains changes
2. **AI agent** reads current task file
3. **AI agent** proposes updates based on learnings or progress
4. **Human** reviews proposed changes
5. **AI agent** updates the task file
6. **Human** confirms updates

### Completing a Task

1. **Human** confirms task is complete
2. **AI agent** reviews task file to ensure all items are done
3. **AI agent** moves file to `tasks/archive/[project-name].md`
4. **AI agent** adds completion date and final notes
5. **Human** confirms archival

## Task File Template

### Multi-Phase Project Template

```markdown
# [Project Name]

## Objective
Brief description of what we're building and why.

## Phase 1: [Phase Name]
**Goal:** What this phase achieves

### Steps
- [ ] Step 1
- [ ] Step 2
- [ ] Step 3

### Success Criteria
- What indicates this phase is complete

## Phase 2: [Phase Name]
...

## Notes
- Design decisions
- Trade-offs
- Learnings
```

## Always

- ✅ Create task files for multi-phase projects
- ✅ Update task files when plans change based on learnings
- ✅ Ask "Ready to proceed with [next step/phase]?" after completing each step
- ✅ Archive completed projects
- ✅ Link to related docs (e.g., `/DOCUMENTATION-WORKFLOW.md`)

## Never

- ❌ Don't skip task planning for complex projects
- ❌ Don't let task files become stale
- ❌ Don't delete completed tasks (archive them)

## Reference

- **Task directory**: `/tasks/`
- **Backlog**: `/tasks/backlog.md`
- **Template**: `/tasks/README.md`
- **Workflow guidelines**: Root `.cursorrules` file

