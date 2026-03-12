// agent-messages: Cross-LLM, cross-IDE agent communication + work orders
// POST { action: "send" | "check" | "respond" | "register" | "who-online" | "mark-read" | "thread"
//                | "post-task" | "claim-task" | "list-tasks" | "update-task" }
// Messages stored in design_space table (category = "agent_message" | "task") — every entry is searchable knowledge

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getEmbedding(text: string): Promise<number[] | null> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.data[0].embedding;
  } catch {
    return null;
  }
}

// ==================== AGENT IDENTITY RESOLUTION ====================
// Agents register with agent_id (primary key) and agent_name.
// Messages can be addressed to either. This function resolves any
// identifier to the full set of known identifiers for that agent,
// so messages always find the right recipient.

interface AgentIdentity {
  canonical_id: string;       // agent_presence.agent_id (primary key)
  all_identifiers: string[];  // [agent_id, agent_name, platform] — all forms that could appear in to_agent
}

function buildIdentitySet(record: { agent_id: string; agent_name?: string; platform?: string }): string[] {
  // Collect all known identifiers + lowercase variants for case-insensitive matching
  const ids = new Set<string>();
  for (const val of [record.agent_id, record.agent_name, record.platform]) {
    if (val) {
      ids.add(val);
      const lower = val.toLowerCase();
      if (lower !== val) ids.add(lower);
    }
  }
  return [...ids];
}

async function resolveAgent(supabase: any, identifier: string): Promise<AgentIdentity | null> {
  if (!identifier) return null;

  // Try exact match on agent_id first (primary key — fast)
  const { data: byId } = await supabase
    .from("agent_presence")
    .select("agent_id, agent_name, platform")
    .eq("agent_id", identifier)
    .single();

  if (byId) {
    return { canonical_id: byId.agent_id, all_identifiers: buildIdentitySet(byId) };
  }

  // Try case-insensitive agent_name match (someone sent to "codex" but name is "Codex")
  const { data: byName } = await supabase
    .from("agent_presence")
    .select("agent_id, agent_name, platform")
    .ilike("agent_name", identifier)
    .limit(1)
    .single();

  if (byName) {
    return { canonical_id: byName.agent_id, all_identifiers: buildIdentitySet(byName) };
  }

  // Try case-insensitive platform match (e.g., "claude-code")
  const { data: byPlatform } = await supabase
    .from("agent_presence")
    .select("agent_id, agent_name, platform")
    .ilike("platform", identifier)
    .limit(1);

  if (byPlatform && byPlatform.length === 1) {
    return { canonical_id: byPlatform[0].agent_id, all_identifiers: buildIdentitySet(byPlatform[0]) };
  }

  // Not registered — return the raw identifier as-is (+ lowercase variant)
  const fallback = [identifier];
  const lower = identifier.toLowerCase();
  if (lower !== identifier) fallback.push(lower);
  return { canonical_id: identifier, all_identifiers: fallback };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { action } = body;

    // ==================== SEND ====================
    if (action === "send") {
      const {
        content, from_agent, from_platform = "claude-code", to_agent,
        project, message_type = "notification", capabilities = [],
        priority = "normal", topics = [], components = [], attachments = [],
      } = body;

      if (!content || !from_agent) {
        return jsonResponse({ error: "content and from_agent are required" }, 400);
      }

      // Resolve to_agent to canonical form so messages are always findable
      let resolved_to: string | null = null;
      if (to_agent) {
        const identity = await resolveAgent(supabase, to_agent);
        resolved_to = identity ? identity.canonical_id : to_agent;
      }

      const thread_id = crypto.randomUUID();
      const embedding = await getEmbedding(content);

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          project,
          topics,
          components,
          embedding,
          thread_id,
          metadata: {
            from_agent,
            from_platform,
            to_agent: resolved_to,
            to_agent_original: to_agent || null, // preserve what the sender typed
            message_type,
            capabilities,
            priority,
            attachments,
            read: false,
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ success: true, message, thread_id });
    }

    // ==================== CHECK ====================
    if (action === "check") {
      const { agent_id, project, include_broadcast = true, since, limit = 20 } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      // Resolve caller identity to get all their known identifiers
      const identity = await resolveAgent(supabase, agent_id);
      const allIds = identity ? identity.all_identifiers : [agent_id];

      // Build message query
      let msgQuery = supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .order("created_at", { ascending: false })
        .limit(limit);

      // Time filter — skip old messages
      if (since) {
        msgQuery = msgQuery.gte("created_at", since);
      }

      if (project) {
        msgQuery = msgQuery.eq("project", project);
      }

      // Build OR filter matching any of the agent's known identifiers
      // Check BOTH to_agent (resolved) and to_agent_original (what sender typed) — belt and suspenders
      const toFilters = allIds.map(id => `metadata->>to_agent.eq.${id}`);
      const origFilters = allIds.map(id => `metadata->>to_agent_original.eq.${id}`);
      const allFilters = [...toFilters, ...origFilters];
      if (include_broadcast) {
        allFilters.push("metadata->>to_agent.is.null");
      }
      msgQuery = msgQuery.or(allFilters.join(","));

      const { data: messages, error: msgError } = await msgQuery;
      if (msgError) throw msgError;

      // Filter out own messages and already-read messages
      const unread = (messages || []).filter((m: any) => {
        const fromAgent = m.metadata?.from_agent;
        // Exclude messages sent by any of this agent's identities
        if (allIds.includes(fromAgent)) return false;
        // Exclude already-read messages
        if (m.metadata?.read === true) return false;
        return true;
      });

      // Fetch work orders assigned to any of this agent's identifiers, or unclaimed
      const assigneeFilters = allIds.map(id => `metadata->>assignee.eq.${id}`).join(",");
      const { data: tasks, error: taskError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "task")
        .in("metadata->>status", ["ready", "in-progress"])
        .or(`${assigneeFilters},metadata->>assignee.is.null`)
        .order("created_at", { ascending: false })
        .limit(10);

      if (taskError) throw taskError;

      return jsonResponse({
        success: true,
        agent_identity: { canonical_id: identity?.canonical_id || agent_id, all_identifiers: allIds },
        messages: unread,
        unread_count: unread.length,
        tasks: tasks || [],
        task_count: (tasks || []).length,
      });
    }

    // ==================== RESPOND ====================
    if (action === "respond") {
      const {
        message_id, thread_id: provided_thread_id,
        content, from_agent, from_platform = "claude-code",
        message_type = "answer", attachments = [],
      } = body;

      if (!content || !from_agent) {
        return jsonResponse({ error: "content and from_agent are required" }, 400);
      }

      let thread_id = provided_thread_id;
      let to_agent: string | null = null;

      if (message_id && !thread_id) {
        const { data: original } = await supabase
          .from("design_space")
          .select("thread_id, metadata")
          .eq("id", message_id)
          .single();

        if (original) {
          thread_id = original.thread_id;
          to_agent = original.metadata?.from_agent || null;
        }
      }

      if (!thread_id) {
        return jsonResponse({ error: "Could not resolve thread_id" }, 400);
      }

      const embedding = await getEmbedding(content);

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          embedding,
          thread_id,
          metadata: {
            from_agent,
            from_platform,
            to_agent,
            message_type,
            attachments,
            read: false,
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ success: true, message });
    }

    // ==================== REGISTER ====================
    if (action === "register") {
      const {
        agent_id, agent_name, model, platform = "claude-code",
        framework, project, working_on, workspace,
        capabilities = [], tools_available = [],
        context_window, status = "online",
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const { data: agent, error } = await supabase
        .from("agent_presence")
        .upsert({
          agent_id,
          agent_name: agent_name || agent_id,
          model,
          platform,
          framework,
          project,
          working_on,
          workspace,
          capabilities,
          tools_available,
          context_window,
          status,
          last_heartbeat: new Date().toISOString(),
        }, { onConflict: "agent_id" })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ success: true, agent });
    }

    // ==================== WHO-ONLINE ====================
    if (action === "who-online") {
      const { project, capability } = body;

      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      let query = supabase
        .from("agent_presence")
        .select("*")
        .eq("status", "online")
        .gte("last_heartbeat", cutoff);

      if (project) {
        query = query.eq("project", project);
      }

      const { data: agents, error } = await query;
      if (error) throw error;

      let filtered = agents || [];
      if (capability) {
        filtered = filtered.filter((a: any) =>
          (a.capabilities || []).includes(capability)
        );
      }

      return jsonResponse({
        success: true,
        agents: filtered,
        online_count: filtered.length,
      });
    }

    // ==================== MARK-READ ====================
    if (action === "mark-read") {
      const { message_ids, agent_id } = body;

      if (!message_ids || !Array.isArray(message_ids)) {
        return jsonResponse({ error: "message_ids array is required" }, 400);
      }

      // Batch update: set read=true and record who read it
      const reader = agent_id || "unknown";
      let marked = 0;

      for (const id of message_ids) {
        const { data: existing } = await supabase
          .from("design_space")
          .select("metadata")
          .eq("id", id)
          .single();

        if (existing) {
          const readBy = existing.metadata?.read_by || [];
          if (!readBy.includes(reader)) {
            readBy.push(reader);
          }

          const { error } = await supabase
            .from("design_space")
            .update({
              metadata: {
                ...existing.metadata,
                read: true,
                read_by: readBy,
                read_at: new Date().toISOString(),
              },
            })
            .eq("id", id);

          if (!error) marked++;
        }
      }

      return jsonResponse({ success: true, marked });
    }

    // ==================== THREAD ====================
    if (action === "thread") {
      const { thread_id } = body;

      if (!thread_id) {
        return jsonResponse({ error: "thread_id is required" }, 400);
      }

      const { data: messages, error } = await supabase
        .from("design_space")
        .select("*")
        .eq("thread_id", thread_id)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return jsonResponse({
        success: true,
        thread_id,
        messages: messages || [],
        count: (messages || []).length,
      });
    }

    // ==================== POST-TASK ====================
    if (action === "post-task") {
      const {
        from_agent, project, title, content, assignee,
        priority = "normal", topics = [], components = [],
      } = body;

      if (!content || !from_agent || !title) {
        return jsonResponse({ error: "content, from_agent, and title are required" }, 400);
      }

      // Resolve assignee to canonical form if specified
      let resolved_assignee: string | null = null;
      if (assignee) {
        const identity = await resolveAgent(supabase, assignee);
        resolved_assignee = identity ? identity.canonical_id : assignee;
      }

      const thread_id = crypto.randomUUID();
      const embedding = await getEmbedding(`${title}\n${content}`);

      const { data: task, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "task",
          project,
          topics,
          components,
          embedding,
          thread_id,
          metadata: {
            title,
            from_agent,
            assignee: resolved_assignee,
            priority,
            status: "ready",
            created_at: new Date().toISOString(),
            claimed_at: null,
            completed_at: null,
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ success: true, task, thread_id });
    }

    // ==================== CLAIM-TASK ====================
    if (action === "claim-task") {
      const { task_id, agent_id } = body;

      if (!task_id || !agent_id) {
        return jsonResponse({ error: "task_id and agent_id are required" }, 400);
      }

      const { data: existing } = await supabase
        .from("design_space")
        .select("metadata, content")
        .eq("id", task_id)
        .eq("category", "task")
        .single();

      if (!existing) {
        return jsonResponse({ error: "Task not found" }, 404);
      }

      if (existing.metadata?.status !== "ready") {
        return jsonResponse({ error: `Task is ${existing.metadata?.status}, not claimable` }, 409);
      }

      // Create a discussion thread linked to this work order
      const discussion_thread_id = crypto.randomUUID();
      const title = existing.metadata?.title || "Untitled work order";

      const { error: threadError } = await supabase
        .from("design_space")
        .insert({
          content: `${agent_id} claimed work order: ${title}`,
          category: "agent_message",
          thread_id: discussion_thread_id,
          metadata: {
            from_agent: agent_id,
            from_platform: "system",
            to_agent: existing.metadata?.from_agent || null,
            message_type: "notification",
            work_order_id: task_id,
            attachments: [],
            read: false,
          },
        });

      if (threadError) throw threadError;

      // Update the work order with assignee and link to discussion thread
      const { data: task, error } = await supabase
        .from("design_space")
        .update({
          metadata: {
            ...existing.metadata,
            assignee: agent_id,
            status: "in-progress",
            claimed_at: new Date().toISOString(),
            discussion_thread_id,
          },
        })
        .eq("id", task_id)
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ success: true, task, discussion_thread_id });
    }

    // ==================== LIST-TASKS ====================
    if (action === "list-tasks") {
      const { agent_id, project, assignee, status, limit = 20 } = body;

      let query = supabase
        .from("design_space")
        .select("*")
        .eq("category", "task")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (project) query = query.eq("project", project);
      if (status) query = query.eq("metadata->>status", status);

      // If assignee specified, resolve and filter. If agent_id given, show their tasks + unclaimed.
      if (assignee) {
        const identity = await resolveAgent(supabase, assignee);
        const ids = identity ? identity.all_identifiers : [assignee];
        const filters = ids.map(id => `metadata->>assignee.eq.${id}`).join(",");
        query = query.or(filters);
      } else if (agent_id) {
        const identity = await resolveAgent(supabase, agent_id);
        const ids = identity ? identity.all_identifiers : [agent_id];
        const filters = ids.map(id => `metadata->>assignee.eq.${id}`).join(",");
        query = query.or(`${filters},metadata->>assignee.is.null`);
      }

      const { data: tasks, error } = await query;
      if (error) throw error;

      return jsonResponse({ success: true, tasks: tasks || [], count: (tasks || []).length });
    }

    // ==================== UPDATE-TASK ====================
    if (action === "update-task") {
      const { task_id, agent_id, status: newStatus, result } = body;

      if (!task_id || !agent_id) {
        return jsonResponse({ error: "task_id and agent_id are required" }, 400);
      }

      const { data: existing } = await supabase
        .from("design_space")
        .select("metadata")
        .eq("id", task_id)
        .eq("category", "task")
        .single();

      if (!existing) {
        return jsonResponse({ error: "Task not found" }, 404);
      }

      const updates: any = { ...existing.metadata };
      if (newStatus) {
        updates.status = newStatus;
        if (newStatus === "done") updates.completed_at = new Date().toISOString();
      }
      if (result) updates.result = result;

      const { data: task, error } = await supabase
        .from("design_space")
        .update({ metadata: updates })
        .eq("id", task_id)
        .select()
        .single();

      if (error) throw error;

      // Post status change to the discussion thread for audit trail
      const discussion_thread_id = existing.metadata?.discussion_thread_id;
      if (discussion_thread_id) {
        const title = existing.metadata?.title || "work order";
        const statusMsg = newStatus
          ? `Status changed to **${newStatus}**${result ? `: ${result}` : ""}`
          : `Updated: ${result || "metadata changed"}`;

        await supabase
          .from("design_space")
          .insert({
            content: `[${title}] ${statusMsg}`,
            category: "agent_message",
            thread_id: discussion_thread_id,
            metadata: {
              from_agent: agent_id,
              from_platform: "system",
              message_type: "notification",
              work_order_id: task_id,
              attachments: [],
              read: false,
            },
          });
      }

      return jsonResponse({ success: true, task });
    }

    return jsonResponse({ error: `Invalid action. Use: send, check, respond, mark-read, thread, register, who-online, post-task, claim-task, list-tasks, update-task` }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
