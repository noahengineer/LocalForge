/**
 * Small models write a todo list at the start of a task and then forget it until the very end,
 * so the Tasks box jumps from "0 done" to "all done". This adds a one-off reminder to a chat
 * request when the agent has an unfinished list and has made TODO_REMIND_EVERY tool calls since it
 * last updated it. The reminder goes at the end of the last tool result, so it is only in that one
 * request (nothing is stored in the session) and the cached prompt prefix stays the same.
 */

export const TODO_REMIND_EVERY = 8

interface Msg {
  role?: unknown
  content?: unknown
  tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>
}
interface TodoItem {
  content?: unknown
  status?: unknown
}

const toolCallsOf = (m: Msg) => (m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls : [])

function parseTodos(args: unknown): TodoItem[] | null {
  try {
    const v = typeof args === 'string' ? JSON.parse(args) : args
    return v && typeof v === 'object' && Array.isArray((v as { todos?: unknown }).todos) ? (v as { todos: TodoItem[] }).todos : null
  } catch {
    return null
  }
}

export function todoReminderText(sinceUpdate: number, current: string | null): string {
  return (
    `<system-reminder>You have made ${sinceUpdate} tool calls since you last updated your todo list, and the user watches it live. ` +
    (current ? `Your current item is "${current}". ` : '') +
    'If you have finished an item, call todowrite now: mark it completed and the next one in_progress. ' +
    'Keep doing this after each item. Do not mention this reminder.</system-reminder>'
  )
}

/** Returns the body with a reminder added when one is due, otherwise the same body. */
export function addTodoReminder(body: Record<string, unknown>, every = TODO_REMIND_EVERY): Record<string, unknown> {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return body
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: unknown } }>) : []
  if (!tools.some((t) => t?.function?.name === 'todowrite')) return body
  // Only in the middle of the agent's own work (the last message is a tool result).
  const last = messages[messages.length - 1] as Msg
  if (last?.role !== 'tool') return body

  let todos: TodoItem[] | null = null
  let since = 0
  let lastBatch = 0
  for (const m of messages as Msg[]) {
    const calls = toolCallsOf(m)
    if (calls.length === 0) continue
    lastBatch = calls.length
    for (const c of calls) {
      const fn = c?.function
      const parsed = fn?.name === 'todowrite' ? parseTodos(fn.arguments) : null
      if (parsed) {
        todos = parsed
        since = 0
      } else since++
    }
  }
  if (!todos) return body
  const open = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  if (open.length === 0) return body
  // Once per `every` calls (a single response can make several calls at once).
  if (since < every || Math.floor(since / every) === Math.floor(Math.max(0, since - lastBatch) / every)) return body

  const cur = todos.find((t) => t.status === 'in_progress')
  const text = todoReminderText(since, typeof cur?.content === 'string' ? cur.content : null)
  let content: unknown
  if (typeof last.content === 'string') content = `${last.content}\n\n${text}`
  else if (Array.isArray(last.content)) content = [...last.content, { type: 'text', text }]
  else return body
  return { ...body, messages: [...messages.slice(0, -1), { ...last, content }] }
}
