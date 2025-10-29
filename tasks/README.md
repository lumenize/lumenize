# Tasks Directory

## Structure

- **`backlog.md`** - Small tasks and ideas for when you have time
- **`[project-name].md`** - Active multi-phase projects
- **`decisions/`** - Research findings and technical decisions
- **`archive/`** - Completed projects (for reference)

## Usage

### Starting a New Project

Create a new task file:
```bash
# tasks/new-feature.md
```

Use this template:
```markdown
# [Project Name]

**Status**: Active | Blocked | Complete
**Started**: YYYY-MM-DD

## Goal
[One sentence description]

## Phases

### Phase 1: [Name]
- [ ] Step 1
- [ ] Step 2

**Notes**: 
- Decision: [Why we chose X over Y]
```

### Completing a Project

Move to archive:
```bash
mv tasks/completed-feature.md tasks/archive/
```

### Recording Decisions

Document research or technical decisions in `decisions/`:
```bash
# tasks/decisions/technology-choice.md
```

## AI Integration

AI coding assistants (via `.cursorrules`) are configured to:
- Look for task files when starting work
- Update checkboxes as work progresses
- Ask "Ready to proceed?" between phases
- Add notes about decisions made

