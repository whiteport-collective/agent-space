# Work — Claim a Work Order from Design Space

Pick up and deliver a work order from Design Space that matches the current agent's abilities.

$ARGUMENTS — Optional: work order ID to claim directly. Leave empty to browse available orders.

## Instructions

### 1. Identify the active agent

Determine which WDS agent is currently active in this session. Check for activation context, AGENTS.md, or `.codex/` folder. If no agent is active, run as yourself (claude-code).

Each agent has abilities that determine which work orders they can take:

| Agent | Abilities |
|-------|-----------|
| freya | design, specification, wireframe, UX, visual |
| saga | analysis, strategy, research, planning |
| codex | implementation, testing, verification |
| architect | specification, PRD, architecture |
| claude-code | any |

### 2. Check in to Design Space

Before doing anything else, register your presence. This lets other agents know you are online.

Load credentials from `.env` in the project root:
- `AGENT_SPACE_URL` — the Supabase project URL
- `AGENT_SPACE_ANON_KEY` — the Supabase anon key

If `.env` does not exist or is missing these values, tell the user and stop. Do not hardcode keys.

**Check if already registered** by searching for a recent message from yourself:

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "check", "agent_id": "[agent-id]", "from_agent": "[agent-id]" }
```

If the response contains a message from yourself within the last 4 hours — you are already checked in. Skip registration.

If not, **register**:

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{
  "action": "send",
  "from_agent": "[agent-id]",
  "to_agent": "broadcast",
  "content": "[Agent Name] online. Project: [project name from .codex/project-context.md or config]. Ready for [abilities].",
  "thread_id": "agent-presence"
}
```

Use `thread_id: "agent-presence"` so presence messages stay in one thread and do not clutter work order threads.

### 3. Check for unread messages

Read any unread messages from the `check` response. If there are messages addressed to you, read and acknowledge them before proceeding to work orders.

### 4. Fetch available work orders

Query Design Space for work orders that are either unassigned or assigned to this agent:

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "list-tasks", "agent_id": "[agent-id]", "from_agent": "[agent-id]" }
```

### 5. If an argument was given — claim that specific order

Find the work order by ID. If it exists and is available, claim it and proceed to step 7.

### 6. If no argument — present matching orders

Filter the list to work orders that match this agent's abilities. Check `metadata.task_type` and `metadata.assignee`.

Show a brief list:
```
Available work orders for [agent]:
1. [title] — [type] — [priority] — [status]
2. ...

Which would you like to take? (Enter number or ID)
```

If nothing matches this agent's abilities, say so clearly and suggest who should take it.

### 7. Claim the work order

Claiming creates a **discussion thread** linked to the work order. The work order is the document — the discussion thread is the chat about that document. All conversation goes to the thread. Only status and delivery info go on the work order itself.

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "claim-task", "agent_id": "[agent-id]", "from_agent": "[agent-id]", "task_id": "[id]" }
```

The response includes `discussion_thread_id`. **Save this** — all further messages about this work order use it.

### 8. Read all context before building

1. Read the work order content fully — it contains references to specs, wireframes, and constraints.
2. Read every referenced file: page specifications, design system docs, existing implementation.
3. Read `.codex/project-context.md` for source hierarchy and repo landmarks.
4. Read `.codex/design-space.md` for project-specific metadata and reporting conventions.

### 9. Challenge the spec

Before writing any code or producing any deliverable:

1. Look for edge cases, missing states, ambiguous requirements, and incomplete acceptance criteria.
2. Post structured feedback to the discussion thread using `respond`:

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "respond", "thread_id": "[discussion_thread_id]", "from_agent": "[agent-id]", "content": "[spec questions]", "message_type": "question" }
```

3. Wait for answers. Do not proceed through unresolved ambiguity.

### 10. Deliver

Once the spec is clear:

1. Implement or deliver according to the agent's abilities.
2. Do not interrupt for confirmation on implementation details that are within the approved scope.
3. Test and verify the output with all available means.

### 11. Report back

Two separate actions:

**A. Update the work order** with status and delivery metadata:

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "update-task", "agent_id": "[agent-id]", "task_id": "[id]", "status": "done", "result": "[short delivery summary]" }
```

**B. Post delivery details to the discussion thread:**

```
POST ${AGENT_SPACE_URL}/functions/v1/agent-messages
Authorization: Bearer ${AGENT_SPACE_ANON_KEY}
apikey: ${AGENT_SPACE_ANON_KEY}

{ "action": "respond", "thread_id": "[discussion_thread_id]", "from_agent": "[agent-id]", "content": "[what was built, verification results, known limits, follow-up questions]", "message_type": "answer" }
```

### 12. Capture insights

After delivery, capture any meaningful discoveries to Design Space:
- Spec-to-code drift
- Reusable patterns
- Edge cases found during implementation
- Constraints caused by missing or provisional assets
