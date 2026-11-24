import { describe, expect, it } from 'vitest'
import { addTodoReminder } from '../src/main/backend/todoReminder'

const TOOLS = [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'todowrite' } }]
const todo = (statuses: string[]) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 't', type: 'function', function: { name: 'todowrite', arguments: JSON.stringify({ todos: statuses.map((s, i) => ({ content: `step ${i + 1}`, status: s, priority: 'high' })) }) } }],
})
const call = (n = 1) => ({ role: 'assistant', content: null, tool_calls: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{}' } })) })
const result = { role: 'tool', tool_call_id: 'c0', content: 'file contents' }

/** A request after `calls` single tool calls following a todo list. */
const req = (statuses: string[], calls: number, extra: Record<string, unknown> = {}) => {
  const messages: unknown[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do it' }, todo(statuses), { role: 'tool', tool_call_id: 't', content: 'ok' }]
  for (let i = 0; i < calls; i++) messages.push(call(), result)
  return { model: 'm', tools: TOOLS, messages, ...extra }
}
const reminded = (b: Record<string, unknown>) => JSON.stringify((b.messages as unknown[]).at(-1)).includes('system-reminder')

describe('todo reminder', () => {
  it('reminds every 8 tool calls while the list has open items', () => {
    const due = [...Array(30).keys()].filter((n) => reminded(addTodoReminder(req(['in_progress', 'pending'], n))))
    expect(due).toEqual([8, 16, 24])
    const b = addTodoReminder(req(['in_progress', 'pending'], 8))
    const last = (b.messages as Array<{ content: string }>).at(-1)!
    expect(last.content.startsWith('file contents\n\n<system-reminder>')).toBe(true)
    expect(last.content).toContain('"step 1"')
  })

  it('only changes the last message', () => {
    const before = req(['in_progress'], 8)
    const after = addTodoReminder(before)
    expect((after.messages as unknown[]).slice(0, -1)).toEqual(before.messages.slice(0, -1))
    expect(before.messages.at(-1)).toEqual(result) // input not mutated
  })

  it('counts from the latest todowrite', () => {
    const b = req(['in_progress', 'pending'], 7)
    b.messages.push(todo(['completed', 'in_progress']), { role: 'tool', tool_call_id: 't', content: 'ok' })
    for (let i = 0; i < 7; i++) b.messages.push(call(), result)
    expect(reminded(addTodoReminder(b))).toBe(false)
    b.messages.push(call(), result)
    expect(reminded(addTodoReminder(b))).toBe(true)
  })

  it('fires once when parallel calls cross the threshold', () => {
    const b = req(['in_progress'], 6)
    b.messages.push(call(3), result)
    expect(reminded(addTodoReminder(b))).toBe(true) // 6 -> 9 crosses 8
    b.messages.push(call(), result)
    expect(reminded(addTodoReminder(b))).toBe(false) // 10
  })

  it('stays quiet when it does not apply', () => {
    expect(reminded(addTodoReminder(req(['completed', 'cancelled'], 8)))).toBe(false) // list done
    expect(reminded(addTodoReminder(req(['in_progress'], 8, { tools: [{ function: { name: 'read' } }] })))).toBe(false) // subagent without todowrite
    const noList = { tools: TOOLS, messages: [{ role: 'user', content: 'x' }, ...Array.from({ length: 8 }, () => [call(), result]).flat()] }
    expect(reminded(addTodoReminder(noList))).toBe(false) // never made a list
    const userLast = req(['in_progress'], 8)
    userLast.messages.push({ role: 'user', content: 'new question' })
    expect(reminded(addTodoReminder(userLast))).toBe(false) // the user just spoke
    const bad = req(['in_progress'], 8)
    ;(bad.messages[2] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0].function.arguments = '{broken'
    expect(reminded(addTodoReminder(bad))).toBe(false)
  })

  it('handles tool results given as content parts', () => {
    const b = req(['in_progress'], 8)
    b.messages[b.messages.length - 1] = { role: 'tool', tool_call_id: 'c0', content: [{ type: 'text', text: 'x' }] }
    const parts = ((addTodoReminder(b).messages as unknown[]).at(-1) as { content: Array<{ text: string }> }).content
    expect(parts).toHaveLength(2)
    expect(parts[1].text).toContain('todowrite')
  })
})
