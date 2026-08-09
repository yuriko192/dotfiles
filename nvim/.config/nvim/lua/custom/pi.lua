-- Multi-provider coding agent integration for Neovim
-- Supports:
--   pi     — RPC mode (JSON over stdin/stdout)
--   cursor — Cursor CLI (`agent -p --output-format stream-json`)

local M = {}

local PROVIDERS = { "pi", "cursor" }

local EFFORT_ORDER = {
  none = 1,
  minimal = 2,
  low = 3,
  medium = 4,
  high = 5,
  xhigh = 6,
  ["extra-high"] = 7,
  max = 8,
}

local EFFORT_LABELS = {
  none = "None",
  minimal = "Minimal",
  low = "Low",
  medium = "Medium",
  high = "High",
  xhigh = "Extra High",
  ["extra-high"] = "Extra High",
  max = "Max",
}

-- Chat line kinds: "user" | "agent" | "tool" | "meta"
local HL = {
  user = "AgentChatUser",
  agent = "AgentChatAgent",
  tool = "AgentChatTool",
  meta = "AgentChatMeta",
  input = "AgentChatInput",
}

local ns_chat = vim.api.nvim_create_namespace("agent_chat")

local function setup_highlights()
  local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
  local bg = normal.bg
  -- Distinct colors for transcript roles (tuned for tokyonight-night)
  vim.api.nvim_set_hl(0, "AgentChatUser", { fg = "#7aa2f7", bg = bg })
  vim.api.nvim_set_hl(0, "AgentChatAgent", { fg = "#c0caf5", bg = bg })
  vim.api.nvim_set_hl(0, "AgentChatTool", { fg = "#e0af68", bg = bg })
  vim.api.nvim_set_hl(0, "AgentChatMeta", { fg = "#565f89", bg = bg, italic = true })
  vim.api.nvim_set_hl(0, "AgentChatInput", { fg = "#7dcfff", bg = bg })
end

local function make_line(text, kind)
  return { text = text or "", kind = kind or "meta" }
end

local state = {
  provider = "pi", -- "pi" | "cursor"
  job_id = nil,
  output_buf = nil,
  output_win = nil,
  input_buf = nil,
  input_win = nil,
  chat_lines = {}, -- completed transcript lines: { text, kind } (persists across asks)
  turn_lines = {}, -- non-streaming lines for the active turn (tools, etc.)
  live_status = nil, -- ephemeral status line for the active turn
  active_tools = {}, -- tool_id -> { index, tool_name, args_str }
  accumulated_text = "",
  status = "idle", -- idle, thinking, streaming, tool
  current_tool = nil,
  current_model = nil, -- { id, name, provider, family?, effort?, thinking?, fast? }
  modified_files = {},
  turn_count = 0,
  cursor_session_id = nil,
  conversation_id = nil, -- local id for persisted cursor chats
  pi_session_file = nil,
  pi_session_id = nil,
  cursor_models = nil, -- cached list from `agent --list-models`
  cursor_families = nil, -- cached grouped families
  pending_context = nil, -- nil | "buffer" | "selection"
  pending_selection = nil, -- captured visual selection for ask-with-selection
  pending_buffer = nil, -- buffer to use for ask-with-buffer context
  saved = {
    provider = "pi",
    cursor_model = nil,
    pi_model = nil,
  },
  _pick_model_id = nil,
  _get_messages_id = nil,
  _switch_session_id = nil,
  _settings_loaded = false,
}

-- ─── Persistence ───────────────────────────────────────────────────────────────

local function settings_path()
  return vim.fn.stdpath("data") .. "/agent-nvim.json"
end

local function save_settings()
  local payload = {
    provider = state.provider,
    cursor_model = state.saved.cursor_model,
    pi_model = state.saved.pi_model,
  }
  local ok, encoded = pcall(vim.json.encode, payload)
  if not ok then
    return
  end
  vim.fn.writefile(vim.split(encoded, "\n", { plain = true }), settings_path())
end

local function load_settings()
  if state._settings_loaded then
    return
  end
  state._settings_loaded = true

  local path = settings_path()
  if vim.fn.filereadable(path) == 0 then
    return
  end

  local lines = vim.fn.readfile(path)
  if not lines or #lines == 0 then
    return
  end

  local ok, data = pcall(vim.json.decode, table.concat(lines, "\n"))
  if not ok or type(data) ~= "table" then
    return
  end

  local function scrub(value)
    if value == vim.NIL then
      return nil
    end
    return value
  end

  if data.provider == "pi" or data.provider == "cursor" then
    state.saved.provider = data.provider
    state.provider = data.provider
  end
  if type(data.cursor_model) == "table" and data.cursor_model.id then
    state.saved.cursor_model = {
      id = data.cursor_model.id,
      name = scrub(data.cursor_model.name),
      family = scrub(data.cursor_model.family),
      effort = scrub(data.cursor_model.effort),
      thinking = data.cursor_model.thinking and true or false,
      fast = data.cursor_model.fast and true or false,
    }
  end
  if type(data.pi_model) == "table" and data.pi_model.id then
    state.saved.pi_model = {
      id = data.pi_model.id,
      name = scrub(data.pi_model.name),
      provider = scrub(data.pi_model.provider),
    }
  end
end

local function persist_cursor_model(model)
  if not model or not model.id then
    return
  end
  state.saved.cursor_model = {
    id = model.id,
    name = model.name or model.id,
    family = model.family,
    effort = model.effort,
    thinking = model.thinking and true or false,
    fast = model.fast and true or false,
  }
  state.saved.provider = "cursor"
  save_settings()
end

local function persist_pi_model(model)
  if not model or not model.id then
    return
  end
  state.saved.pi_model = {
    id = model.id,
    name = model.name or model.id,
    provider = model.provider,
  }
  state.saved.provider = "pi"
  save_settings()
end

-- ─── Conversation persistence (cursor) + pi session listing ─────────────────────

local function cwd_key(cwd)
  cwd = vim.fn.resolve(cwd or vim.fn.getcwd())
  return cwd:gsub("^[/\\]", ""):gsub("[/\\:]", "-")
end

local function conversations_dir(cwd)
  return vim.fn.stdpath("data") .. "/agent-conversations/" .. cwd_key(cwd)
end

local function ensure_dir(path)
  if vim.fn.isdirectory(path) == 0 then
    vim.fn.mkdir(path, "p")
  end
end

local function new_id()
  return tostring(os.time()) .. "-" .. tostring(math.random(100000, 999999))
end

local function first_user_preview(chat_lines)
  for _, entry in ipairs(chat_lines or {}) do
    if entry.kind == "user" and entry.text and not entry.text:match("^──") and vim.trim(entry.text) ~= "" then
      local text = vim.trim(entry.text):gsub("%s+", " ")
      if #text > 72 then
        return text:sub(1, 72) .. "…"
      end
      return text
    end
  end
  return "(empty)"
end

local function conversation_path(id, cwd)
  return conversations_dir(cwd) .. "/" .. id .. ".json"
end

local function save_cursor_conversation()
  if state.provider ~= "cursor" then
    return
  end
  if #state.chat_lines == 0 and not state.cursor_session_id then
    return
  end
  if not state.conversation_id then
    state.conversation_id = new_id()
  end
  local cwd = vim.fn.getcwd()
  ensure_dir(conversations_dir(cwd))
  local payload = {
    id = state.conversation_id,
    provider = "cursor",
    session_id = state.cursor_session_id,
    cwd = cwd,
    title = first_user_preview(state.chat_lines),
    updated_at = os.time(),
    chat_lines = state.chat_lines,
    model = state.current_model,
  }
  local ok, encoded = pcall(vim.json.encode, payload)
  if not ok then
    return
  end
  vim.fn.writefile(vim.split(encoded, "\n", { plain = true }), conversation_path(state.conversation_id, cwd))
end

local function list_cursor_conversations(cwd)
  cwd = cwd or vim.fn.getcwd()
  local dir = conversations_dir(cwd)
  if vim.fn.isdirectory(dir) == 0 then
    return {}
  end
  local items = {}
  for _, name in ipairs(vim.fn.readdir(dir) or {}) do
    if name:match("%.json$") then
      local path = dir .. "/" .. name
      local lines = vim.fn.readfile(path)
      if lines and #lines > 0 then
        local ok, data = pcall(vim.json.decode, table.concat(lines, "\n"))
        if ok and type(data) == "table" and data.id then
          table.insert(items, {
            provider = "cursor",
            id = data.id,
            session_id = data.session_id,
            title = data.title or first_user_preview(data.chat_lines),
            updated_at = data.updated_at or 0,
            chat_lines = data.chat_lines or {},
            model = data.model,
            path = path,
          })
        end
      end
    end
  end
  table.sort(items, function(left, right)
    return (left.updated_at or 0) > (right.updated_at or 0)
  end)
  return items
end

local function pi_sessions_dir(cwd)
  cwd = vim.fn.resolve(cwd or vim.fn.getcwd())
  local safe = cwd:gsub("^[/\\]", ""):gsub("[/\\:]", "-")
  return vim.fn.expand("~/.pi/agent/sessions/--" .. safe .. "--")
end

local function extract_message_text(content)
  if type(content) == "string" then
    return content
  end
  if type(content) ~= "table" then
    return ""
  end
  local parts = {}
  for _, block in ipairs(content) do
    if type(block) == "table" and block.type == "text" and block.text then
      table.insert(parts, block.text)
    end
  end
  return table.concat(parts, "\n")
end

local function list_pi_sessions(cwd)
  local dir = pi_sessions_dir(cwd)
  if vim.fn.isdirectory(dir) == 0 then
    return {}
  end
  local items = {}
  for _, name in ipairs(vim.fn.readdir(dir) or {}) do
    if name:match("%.jsonl$") then
      local path = dir .. "/" .. name
      local lines = vim.fn.readfile(path, "", 200)
      if lines and #lines > 0 then
        local header = nil
        local title = nil
        local session_name = nil
        local message_count = 0
        local updated_at = 0
        for _, line in ipairs(lines) do
          if line ~= "" then
            local ok, entry = pcall(vim.json.decode, line)
            if ok and type(entry) == "table" then
              if not header then
                if entry.type == "session" and entry.id then
                  header = entry
                else
                  break
                end
              elseif entry.type == "session_info" and type(entry.name) == "string" and entry.name ~= "" then
                session_name = entry.name
              elseif entry.type == "message" and entry.message then
                message_count = message_count + 1
                local role = entry.message.role
                if role == "user" and not title then
                  local text = extract_message_text(entry.message.content)
                  if text ~= "" then
                    title = vim.trim(text):gsub("%s+", " ")
                    if #title > 72 then
                      title = title:sub(1, 72) .. "…"
                    end
                  end
                end
              end
            end
          end
        end
        if header then
          local mtime = vim.fn.getftime(path)
          table.insert(items, {
            provider = "pi",
            id = header.id,
            path = path,
            title = session_name or title or "(no messages)",
            updated_at = mtime > 0 and mtime or updated_at,
            message_count = message_count,
          })
        end
      end
    end
  end
  table.sort(items, function(left, right)
    return (left.updated_at or 0) > (right.updated_at or 0)
  end)
  return items
end

local function format_relative_time(timestamp)
  if not timestamp or timestamp == 0 then
    return "?"
  end
  return os.date("%Y-%m-%d %H:%M", timestamp)
end

local TOOL_STATUS_ICONS = {
  loading = "⏳",
  done = "✅",
  failed = "❌",
}

local function format_tool_args(tool_name, args, description)
  if type(args) == "table" then
    if args.command then
      return args.command
    end
    if args.path then
      return args.path
    end
  end
  if type(description) == "string" and description ~= "" then
    return description
  end
  return ""
end

local function format_tool_line(status, tool_name, args_str)
  local icon = TOOL_STATUS_ICONS[status] or TOOL_STATUS_ICONS.loading
  local name = tool_name or "tool"
  if args_str and args_str ~= "" then
    return icon .. " " .. name .. ": " .. args_str
  end
  return icon .. " " .. name
end

local function chat_lines_from_pi_messages(messages)
  local lines = { make_line("── agent chat ──", "meta"), make_line("", "meta") }
  local pending_tools = {}
  local first = true
  for _, msg in ipairs(messages or {}) do
    local role = msg.role
    if role == "user" then
      if not first then
        table.insert(lines, make_line("", "meta"))
        table.insert(lines, make_line("────────────────────────────────────", "meta"))
        table.insert(lines, make_line("", "meta"))
      end
      first = false
      table.insert(lines, make_line("── You ──", "user"))
      local text = extract_message_text(msg.content)
      for _, line in ipairs(vim.split(text, "\n", { plain = true })) do
        table.insert(lines, make_line(line, "user"))
      end
      table.insert(lines, make_line("", "meta"))
    elseif role == "assistant" then
      table.insert(lines, make_line("── Agent ──", "agent"))
      if type(msg.content) == "table" then
        for _, block in ipairs(msg.content) do
          if type(block) == "table" then
            if block.type == "text" and block.text then
              for _, line in ipairs(vim.split(block.text, "\n", { plain = true })) do
                table.insert(lines, make_line(line, "agent"))
              end
            elseif block.type == "toolCall" then
              local args_str = format_tool_args(block.name, block.arguments)
              local tool_id = block.id or block.toolCallId or block.name or "tool"
              table.insert(lines, make_line("", "meta"))
              table.insert(lines, make_line(format_tool_line("done", block.name, args_str), "tool"))
              pending_tools[tool_id] = {
                index = #lines,
                tool_name = block.name or "tool",
                args_str = args_str,
              }
            end
          end
        end
      else
        local text = extract_message_text(msg.content)
        for _, line in ipairs(vim.split(text, "\n", { plain = true })) do
          table.insert(lines, make_line(line, "agent"))
        end
      end
      table.insert(lines, make_line("", "meta"))
    elseif role == "toolResult" then
      local tool_id = msg.toolCallId or msg.toolUseId or msg.toolName or "tool"
      local status = msg.isError and "failed" or "done"
      local pending = pending_tools[tool_id]
      if pending and lines[pending.index] then
        lines[pending.index].text = format_tool_line(
          status,
          msg.toolName or pending.tool_name,
          pending.args_str
        )
        pending_tools[tool_id] = nil
      else
        table.insert(lines, make_line(format_tool_line(status, msg.toolName, ""), "tool"))
      end
    end
  end
  return lines
end

-- ─── Helpers ───────────────────────────────────────────────────────────────────

local refresh_input_winbar -- forward declaration

local function notify(msg, level)
  vim.schedule(function()
    vim.notify("agent: " .. msg, level or vim.log.levels.INFO)
  end)
end

local function model_status_label(model)
  if not model then
    return nil
  end
  local label = model.name or model.id or "unknown"
  if model.provider == "cursor" or state.provider == "cursor" then
    local parts = {}
    if model.effort then
      table.insert(parts, EFFORT_LABELS[model.effort] or model.effort)
    end
    if model.thinking then
      table.insert(parts, "think")
    end
    if model.fast then
      table.insert(parts, "fast")
    end
    if #parts > 0 then
      local base = model.family_label or model.family or label
      label = base .. " [" .. table.concat(parts, ", ") .. "]"
    end
  end
  return label
end

local function set_buf_lines(buf, lines)
  if buf and vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_set_option(buf, "modifiable", true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(buf, "modifiable", false)
  end
end

local function scroll_output_to_bottom()
  if state.output_win and vim.api.nvim_win_is_valid(state.output_win) and state.output_buf then
    local line_count = vim.api.nvim_buf_line_count(state.output_buf)
    vim.api.nvim_win_set_cursor(state.output_win, { line_count, 0 })
  end
end

local function build_chat_view()
  local entries = {}
  for _, entry in ipairs(state.chat_lines) do
    table.insert(entries, entry)
  end
  if state.live_status then
    table.insert(entries, make_line(state.live_status, "meta"))
    table.insert(entries, make_line("", "meta"))
  end
  for _, entry in ipairs(state.turn_lines) do
    table.insert(entries, entry)
  end
  if state.accumulated_text ~= "" then
    for _, line in ipairs(vim.split(state.accumulated_text, "\n", { plain = true })) do
      table.insert(entries, make_line(line, "agent"))
    end
  end
  if #entries == 0 then
    return {
      make_line("── agent chat ──", "meta"),
      make_line("", "meta"),
      make_line("Ask from the input below (Enter to send, Alt+Enter for newline).", "meta"),
      make_line("Resume a previous conversation with :PiResume or <leader><C-p>r.", "meta"),
    }
  end
  return entries
end

local function apply_chat_highlights(buf, entries)
  vim.api.nvim_buf_clear_namespace(buf, ns_chat, 0, -1)
  for row, entry in ipairs(entries) do
    local hl = HL[entry.kind] or HL.meta
    -- line_hl_group + high priority so markdown treesitter does not wash out role colors
    vim.api.nvim_buf_set_extmark(buf, ns_chat, row - 1, 0, {
      end_row = row - 1,
      end_col = #entry.text,
      hl_group = hl,
      line_hl_group = hl,
      priority = 200,
    })
  end
end

local function render_chat()
  if not state.output_buf or not vim.api.nvim_buf_is_valid(state.output_buf) then
    return
  end
  local entries = build_chat_view()
  local lines = {}
  for _, entry in ipairs(entries) do
    table.insert(lines, entry.text)
  end
  set_buf_lines(state.output_buf, lines)
  apply_chat_highlights(state.output_buf, entries)
  scroll_output_to_bottom()
end

local function flush_accumulated_to_turn()
  if state.accumulated_text == "" then
    return
  end
  for _, line in ipairs(vim.split(state.accumulated_text, "\n", { plain = true })) do
    table.insert(state.turn_lines, make_line(line, "agent"))
  end
  state.accumulated_text = ""
end

local function append_turn_lines(lines, kind)
  kind = kind or "meta"
  flush_accumulated_to_turn()
  for _, line in ipairs(lines) do
    table.insert(state.turn_lines, make_line(line, kind))
  end
  render_chat()
end

local function next_tool_id(tool_name)
  local prefix = tool_name or "tool"
  local sequence = 1
  while state.active_tools[prefix .. "#" .. sequence] do
    sequence = sequence + 1
  end
  return prefix .. "#" .. sequence
end

local function begin_tool_display(tool_id, tool_name, args_str)
  tool_id = (tool_id and tool_id ~= "") and tostring(tool_id) or next_tool_id(tool_name)
  flush_accumulated_to_turn()
  table.insert(state.turn_lines, make_line("", "meta"))
  table.insert(state.turn_lines, make_line(format_tool_line("loading", tool_name, args_str), "tool"))
  state.active_tools[tool_id] = {
    index = #state.turn_lines,
    tool_name = tool_name or "tool",
    args_str = args_str or "",
  }
  render_chat()
  return tool_id
end

local function finish_tool_display(tool_id, status, tool_name, args_str)
  if tool_id ~= nil and tool_id ~= "" then
    tool_id = tostring(tool_id)
  else
    tool_id = nil
  end

  local pending = tool_id and state.active_tools[tool_id] or nil
  if not pending and tool_name then
    local oldest_id, oldest_index = nil, math.huge
    for id, entry in pairs(state.active_tools) do
      if entry.tool_name == tool_name and entry.index < oldest_index then
        oldest_id = id
        oldest_index = entry.index
        pending = entry
      end
    end
    tool_id = oldest_id
  end

  if pending and state.turn_lines[pending.index] then
    state.turn_lines[pending.index].text = format_tool_line(
      status,
      tool_name or pending.tool_name,
      (args_str and args_str ~= "") and args_str or pending.args_str
    )
    if tool_id then
      state.active_tools[tool_id] = nil
    end
    render_chat()
    return
  end

  append_turn_lines({ format_tool_line(status, tool_name, args_str) }, "tool")
end

local function append_user_message(display)
  if #state.chat_lines > 0 then
    table.insert(state.chat_lines, make_line("", "meta"))
    table.insert(state.chat_lines, make_line("────────────────────────────────────", "meta"))
    table.insert(state.chat_lines, make_line("", "meta"))
  else
    table.insert(state.chat_lines, make_line("── agent chat ──", "meta"))
    table.insert(state.chat_lines, make_line("", "meta"))
  end
  table.insert(state.chat_lines, make_line("── You ──", "user"))
  for _, line in ipairs(vim.split(display or "", "\n", { plain = true })) do
    table.insert(state.chat_lines, make_line(line, "user"))
  end
  table.insert(state.chat_lines, make_line("", "meta"))
  render_chat()
  save_cursor_conversation()
end

local function begin_agent_turn(status_label)
  state.accumulated_text = ""
  state.turn_lines = { make_line("── Agent ──", "agent") }
  state.live_status = status_label or "── processing... ──"
  state.active_tools = {}
  state.turn_count = 0
  state.modified_files = {}
  state.current_tool = nil
  state.status = "thinking"
  render_chat()
end

local function commit_agent_turn()
  state.live_status = nil
  for tool_id, pending in pairs(state.active_tools) do
    if state.turn_lines[pending.index] then
      state.turn_lines[pending.index].text = format_tool_line("failed", pending.tool_name, pending.args_str)
    end
    state.active_tools[tool_id] = nil
  end
  for _, entry in ipairs(state.turn_lines) do
    table.insert(state.chat_lines, entry)
  end
  if state.accumulated_text ~= "" then
    for _, line in ipairs(vim.split(state.accumulated_text, "\n", { plain = true })) do
      table.insert(state.chat_lines, make_line(line, "agent"))
    end
  end
  if #state.modified_files > 0 then
    table.insert(state.chat_lines, make_line("", "meta"))
    table.insert(state.chat_lines, make_line("Modified files:", "meta"))
    for _, file_path in ipairs(state.modified_files) do
      table.insert(state.chat_lines, make_line("  • " .. file_path, "meta"))
    end
  end
  state.accumulated_text = ""
  state.turn_lines = {}
  state.active_tools = {}
  render_chat()
  save_cursor_conversation()
end

local function clear_chat()
  state.chat_lines = {}
  state.turn_lines = {}
  state.live_status = nil
  state.active_tools = {}
  state.accumulated_text = ""
  render_chat()
end

local function render_accumulated_text()
  render_chat()
end

local function update_input_placeholder()
  if not state.input_buf or not vim.api.nvim_buf_is_valid(state.input_buf) then
    return
  end
  local ctx = state.pending_context
  local suffix = ""
  if ctx == "buffer" then
    suffix = " [+buffer]"
  elseif ctx == "selection" then
    suffix = " [+selection]"
  end
  pcall(vim.api.nvim_buf_set_name, state.input_buf, "agent://ask" .. suffix)
  pcall(vim.api.nvim_buf_set_option, state.input_buf, "filetype", "markdown")
  refresh_input_winbar()
end

local function update_statusline()
  vim.schedule(function()
    local icon = ({
      idle = "💤",
      thinking = "🧠",
      streaming = "✍️ ",
      tool = "🔧",
    })[state.status] or "❓"
    local provider = state.provider or "pi"
    vim.g.pi_status = icon .. " " .. provider .. ": " .. state.status
    if state.current_tool then
      vim.g.pi_status = vim.g.pi_status .. " (" .. state.current_tool .. ")"
    end
    refresh_input_winbar()
    vim.cmd("redrawstatus!")
  end)
end

local function reload_modified_buffer(path)
  if not path then
    return
  end
  table.insert(state.modified_files, path)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      local buf_name = vim.api.nvim_buf_get_name(buf)
      if buf_name == path then
        vim.api.nvim_buf_call(buf, function()
          vim.cmd("checktime")
        end)
      end
    end
  end
end

-- ─── Sidebar (chat + bottom input) ─────────────────────────────────────────────

local submit_input -- forward declaration
local ensure_sidebar -- forward declaration

local function configure_output_win(win)
  vim.api.nvim_win_set_option(win, "wrap", true)
  vim.api.nvim_win_set_option(win, "linebreak", true)
  vim.api.nvim_win_set_option(win, "number", false)
  vim.api.nvim_win_set_option(win, "relativenumber", false)
  vim.api.nvim_win_set_option(win, "signcolumn", "no")
  vim.api.nvim_win_set_option(win, "foldcolumn", "0")
  vim.api.nvim_win_set_option(win, "list", false)
end

refresh_input_winbar = function()
  if not state.input_win or not vim.api.nvim_win_is_valid(state.input_win) then
    return
  end
  local provider = state.provider or "pi"
  local model = "—"
  if state.current_model then
    model = model_status_label(state.current_model) or state.current_model.id or "—"
  end
  local ctx = ""
  if state.pending_context == "buffer" then
    ctx = " · +buffer"
  elseif state.pending_context == "selection" then
    ctx = " · +selection"
  end
  local label = string.format(" %s ask%s  ·  %s  ·  Enter send · Alt+Enter newline ", provider, ctx, model)
  pcall(vim.api.nvim_set_option_value, "winbar", label, { win = state.input_win })
end

local function configure_input_win(win)
  vim.api.nvim_win_set_option(win, "wrap", true)
  vim.api.nvim_win_set_option(win, "linebreak", true)
  vim.api.nvim_win_set_option(win, "number", false)
  vim.api.nvim_win_set_option(win, "relativenumber", false)
  vim.api.nvim_win_set_option(win, "signcolumn", "no")
  vim.api.nvim_win_set_option(win, "foldcolumn", "0")
  vim.api.nvim_win_set_option(win, "list", false)
  vim.api.nvim_win_set_option(win, "winhl", "WinBar:StatusLine,Normal:AgentChatInput")
  refresh_input_winbar()
end

local function ensure_output_buf()
  if state.output_buf and vim.api.nvim_buf_is_valid(state.output_buf) then
    return state.output_buf
  end
  state.output_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(state.output_buf, "agent://output")
  vim.api.nvim_buf_set_option(state.output_buf, "buftype", "nofile")
  vim.api.nvim_buf_set_option(state.output_buf, "bufhidden", "hide")
  vim.api.nvim_buf_set_option(state.output_buf, "filetype", "markdown")
  vim.api.nvim_buf_set_option(state.output_buf, "modifiable", false)
  vim.api.nvim_buf_set_option(state.output_buf, "swapfile", false)
  vim.keymap.set("n", "q", function()
    require("custom.pi").close_output()
  end, { buffer = state.output_buf, silent = true, desc = "Close agent sidebar" })
  vim.keymap.set("n", "i", function()
    ensure_sidebar({ focus_input = true })
  end, { buffer = state.output_buf, silent = true, desc = "Focus agent input" })
  vim.keymap.set("n", "a", function()
    ensure_sidebar({ focus_input = true })
  end, { buffer = state.output_buf, silent = true, desc = "Focus agent input" })
  return state.output_buf
end

local function ensure_input_buf()
  if state.input_buf and vim.api.nvim_buf_is_valid(state.input_buf) then
    return state.input_buf
  end
  state.input_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_option(state.input_buf, "buftype", "nofile")
  vim.api.nvim_buf_set_option(state.input_buf, "bufhidden", "hide")
  vim.api.nvim_buf_set_option(state.input_buf, "swapfile", false)
  vim.api.nvim_buf_set_option(state.input_buf, "modifiable", true)
  update_input_placeholder()

  local map_opts = { buffer = state.input_buf, silent = true, noremap = true }
  vim.keymap.set({ "n", "i" }, "<CR>", function() submit_input() end, map_opts)
  vim.keymap.set("i", "<M-CR>", "<CR>", map_opts)
  vim.keymap.set("i", "<A-CR>", "<CR>", map_opts)
  vim.keymap.set("n", "q", function()
    require("custom.pi").close_output()
  end, map_opts)
  vim.keymap.set({ "n", "i" }, "<C-c>", function()
    if state.input_buf and vim.api.nvim_buf_is_valid(state.input_buf) then
      vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, {})
    end
    vim.cmd("stopinsert")
    if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
      vim.api.nvim_set_current_win(state.output_win)
    end
  end, map_opts)
  return state.input_buf
end

ensure_sidebar = function(opts)
  opts = opts or {}
  local prev_win = vim.api.nvim_get_current_win()
  ensure_output_buf()
  ensure_input_buf()
  update_input_placeholder()

  local output_open = state.output_win and vim.api.nvim_win_is_valid(state.output_win)
  local input_open = state.input_win and vim.api.nvim_win_is_valid(state.input_win)

  if not output_open then
    vim.cmd("botright vsplit")
    state.output_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(state.output_win, state.output_buf)
    vim.api.nvim_win_set_width(state.output_win, 80)
    configure_output_win(state.output_win)
  end

  if not input_open then
    vim.api.nvim_set_current_win(state.output_win)
    vim.cmd("belowright split")
    state.input_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(state.input_win, state.input_buf)
    vim.api.nvim_win_set_height(state.input_win, 6)
    configure_input_win(state.input_win)
  else
    if vim.api.nvim_win_get_buf(state.input_win) ~= state.input_buf then
      vim.api.nvim_win_set_buf(state.input_win, state.input_buf)
    end
    configure_input_win(state.input_win)
  end

  if vim.api.nvim_win_get_buf(state.output_win) ~= state.output_buf then
    vim.api.nvim_win_set_buf(state.output_win, state.output_buf)
  end

  render_chat()

  if opts.focus_input then
    vim.api.nvim_set_current_win(state.input_win)
    vim.cmd("startinsert!")
  elseif opts.focus_output then
    vim.api.nvim_set_current_win(state.output_win)
  elseif opts.focus_output == false then
    if vim.api.nvim_win_is_valid(prev_win)
      and prev_win ~= state.output_win
      and prev_win ~= state.input_win
    then
      vim.api.nvim_set_current_win(prev_win)
    end
  else
    vim.api.nvim_set_current_win(state.output_win)
  end
end

local function create_output_window()
  ensure_sidebar({ focus_input = false, focus_output = true })
end

local function close_output()
  if state.input_win and vim.api.nvim_win_is_valid(state.input_win) then
    vim.api.nvim_win_close(state.input_win, true)
  end
  state.input_win = nil
  if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
    vim.api.nvim_win_close(state.output_win, true)
  end
  state.output_win = nil
end

local function input_winbar()
  refresh_input_winbar()
  return ""
end

-- ─── Pi RPC ────────────────────────────────────────────────────────────────────

local start_pi -- forward declaration

local function send_pi_command(cmd)
  if not state.job_id or state.provider ~= "pi" then
    start_pi()
  end
  if not state.job_id or state.provider ~= "pi" then
    notify("Failed to start pi", vim.log.levels.ERROR)
    return false
  end
  local json = vim.json.encode(cmd) .. "\n"
  vim.fn.chansend(state.job_id, json)
  return true
end

local function handle_pi_event(event)
  vim.schedule(function()
    if event.type == "response" then
      local is_tracked = (event.id and event.id == state._pick_model_id)
        or (event.id and event.id == state._switch_session_id)
        or (event.id and event.id == state._get_messages_id)
      if not event.success and not is_tracked then
        notify("Error: " .. (event.error or "unknown"), vim.log.levels.ERROR)
      end
      if event.success and event.command == "get_state" and event.data then
        if event.data.sessionFile then
          state.pi_session_file = event.data.sessionFile
        end
        if event.data.sessionId then
          state.pi_session_id = event.data.sessionId
        end
        if event.data.model then
          if state.saved.pi_model and state.saved.pi_model.id and state._restore_pi_model then
            state._restore_pi_model = false
            local saved = state.saved.pi_model
            local current = event.data.model
            if current.id ~= saved.id or current.provider ~= saved.provider then
              send_pi_command({ type = "set_model", provider = saved.provider, modelId = saved.id })
              return
            end
          end
          state.current_model = event.data.model
          persist_pi_model(state.current_model)
          update_statusline()
        end
      elseif event.success and event.command == "set_model" and event.data then
        state.current_model = event.data
        persist_pi_model(state.current_model)
        update_statusline()
      elseif event.success and event.command == "cycle_model" and event.data and event.data.model then
        state.current_model = event.data.model
        persist_pi_model(state.current_model)
        update_statusline()
      elseif event.success and event.command == "get_available_models" and event.id and event.id == state._pick_model_id then
        state._pick_model_id = nil
        local models = event.data and event.data.models or {}
        if #models == 0 then
          notify("No models available", vim.log.levels.WARN)
        else
          local items = {}
          for _, model in ipairs(models) do
            table.insert(items, {
              display = (model.name or model.id) .. " (" .. (model.provider or "?") .. ")",
              model = model,
            })
          end
          vim.ui.select(items, {
            prompt = "Select pi model:",
            format_item = function(item) return item.display end,
          }, function(choice)
            if choice then
              send_pi_command({ type = "set_model", provider = choice.model.provider, modelId = choice.model.id })
            end
          end)
        end
      elseif event.command == "switch_session" and event.id and event.id == state._switch_session_id then
        state._switch_session_id = nil
        if not event.success then
          notify("Failed to switch session: " .. (event.error or "unknown"), vim.log.levels.ERROR)
          return
        end
        if event.data and event.data.cancelled then
          notify("Session switch cancelled", vim.log.levels.WARN)
          return
        end
        local req_id = "get_messages_" .. tostring(os.time())
        state._get_messages_id = req_id
        send_pi_command({ type = "get_messages", id = req_id })
        send_pi_command({ type = "get_state" })
      elseif event.command == "get_messages" and event.id and event.id == state._get_messages_id then
        state._get_messages_id = nil
        if not event.success then
          notify("Failed to load messages: " .. (event.error or "unknown"), vim.log.levels.ERROR)
          return
        end
        local messages = event.data and event.data.messages or {}
        state.chat_lines = chat_lines_from_pi_messages(messages)
        state.turn_lines = {}
        state.live_status = nil
        state.active_tools = {}
        state.accumulated_text = ""
        ensure_sidebar({ focus_input = true })
        render_chat()
        notify("resumed pi session (" .. tostring(#messages) .. " messages)")
      end
      return
    end

    if event.type == "agent_start" then
      ensure_sidebar({ focus_output = false })
      begin_agent_turn("── pi processing... ──")
      update_statusline()

    elseif event.type == "message_update" then
      local delta = event.assistantMessageEvent
      if not delta then return end

      if delta.type == "text_delta" then
        state.status = "streaming"
        state.current_tool = nil
        state.live_status = nil
        update_statusline()
        state.accumulated_text = state.accumulated_text .. delta.delta
        render_accumulated_text()
      elseif delta.type == "thinking_delta" then
        state.status = "thinking"
        update_statusline()
      end

    elseif event.type == "tool_execution_start" then
      state.status = "tool"
      state.current_tool = event.toolName
      state.live_status = nil
      update_statusline()

      local args_str = format_tool_args(event.toolName, event.args)
      begin_tool_display(event.toolCallId or event.id, event.toolName, args_str)

    elseif event.type == "tool_execution_end" then
      local status = event.isError and "failed" or "done"
      local args_str = format_tool_args(event.toolName, event.args)
      finish_tool_display(event.toolCallId or event.id, status, event.toolName, args_str)

      if event.toolName == "write" or event.toolName == "edit" then
        reload_modified_buffer(event.args and event.args.path)
      end

      state.current_tool = nil
      update_statusline()

    elseif event.type == "message_end" then
      local msg = event.message
      if msg and msg.role == "assistant" and msg.model then
        state.current_model = {
          id = msg.model,
          name = msg.model,
          provider = msg.provider,
        }
        update_statusline()
      end

    elseif event.type == "turn_start" then
      state.turn_count = state.turn_count + 1

    elseif event.type == "agent_end" then
      state.status = "idle"
      state.current_tool = nil
      update_statusline()
      commit_agent_turn()

    elseif event.type == "compaction_start" then
      append_turn_lines({ "", "📦 Compacting context..." })

    elseif event.type == "compaction_end" then
      append_turn_lines({ "📦 Compaction done" })

    elseif event.type == "auto_retry_start" then
      append_turn_lines({
        "",
        "🔄 Retrying (attempt " .. event.attempt .. "/" .. event.maxAttempts .. ")...",
      })

    elseif event.type == "auto_retry_end" then
      if event.success then
        append_turn_lines({ "🔄 Retry succeeded" })
      else
        append_turn_lines({ "❌ Retry failed: " .. (event.finalError or "") })
      end
    end
  end)
end

start_pi = function()
  if state.provider ~= "pi" then
    return
  end
  if state.job_id then
    return
  end

  local stdout_remainder = ""

  state.job_id = vim.fn.jobstart({ "pi", "--mode", "rpc" }, {
    on_stdout = function(_, data)
      for index, chunk in ipairs(data) do
        if index == 1 then
          stdout_remainder = stdout_remainder .. chunk
        else
          local line = stdout_remainder
          if line:sub(-1) == "\r" then
            line = line:sub(1, -2)
          end
          if line ~= "" then
            local ok, event = pcall(vim.json.decode, line)
            if ok and event then
              handle_pi_event(event)
            end
          end
          stdout_remainder = chunk
        end
      end
    end,
    on_stderr = function(_, data)
      local msg = table.concat(data, "")
      if msg ~= "" then
        notify("pi stderr: " .. msg, vim.log.levels.WARN)
      end
    end,
    on_exit = function(_, code)
      state.job_id = nil
      state.status = "idle"
      update_statusline()
      notify("pi exited with code " .. code)
    end,
    stdout_buffered = false,
    stderr_buffered = true,
  })

  if state.job_id <= 0 then
    state.job_id = nil
    notify("Failed to start pi", vim.log.levels.ERROR)
    return
  end

  state.status = "idle"
  update_statusline()
  notify("pi started")
  if state.saved.pi_model and state.saved.pi_model.id then
    state._restore_pi_model = true
  end
  send_pi_command({ type = "get_state" })
end

-- ─── Cursor CLI ────────────────────────────────────────────────────────────────

local function cursor_binary()
  if vim.fn.executable("agent") == 1 then
    return "agent"
  end
  return nil
end

local function ends_with(value, suffix)
  return value:sub(-#suffix) == suffix
end

local function parse_cursor_model_id(model_id)
  local rest = model_id
  local fast = false
  local thinking = false
  local effort = nil

  if ends_with(rest, "-fast") then
    fast = true
    rest = rest:sub(1, -6)
  end

  if ends_with(rest, "-thinking") then
    thinking = true
    rest = rest:sub(1, -10)
  end

  for _, token in ipairs({ "extra-high", "xhigh", "minimal", "medium", "none", "low", "high", "max" }) do
    local suffix = "-" .. token
    if ends_with(rest, suffix) then
      effort = token
      rest = rest:sub(1, -(#suffix + 1))
      break
    end
  end

  if ends_with(rest, "-thinking") then
    thinking = true
    rest = rest:sub(1, -10)
  end

  return {
    family = rest,
    effort = effort,
    thinking = thinking,
    fast = fast,
  }
end

local function clean_family_label(name)
  local label = name or ""
  label = label:gsub("%s*%(current, default%)", "")
  label = label:gsub("%s*%(NO ZDR%)", "")
  label = label:gsub("%s+Thinking", "")
  label = label:gsub("%s+Fast", "")
  label = label:gsub("%s+Extra High", "")
  label = label:gsub("%s+Minimal", "")
  label = label:gsub("%s+Medium", "")
  label = label:gsub("%s+None", "")
  label = label:gsub("%s+Low", "")
  label = label:gsub("%s+High", "")
  label = label:gsub("%s+Max", "")
  label = vim.trim(label)
  if label == "" then
    return name
  end
  return label
end

local function parse_cursor_models(lines)
  local models = {}
  for _, line in ipairs(lines) do
    local trimmed = vim.trim(line)
    if trimmed ~= ""
      and trimmed ~= "Available models"
      and not vim.startswith(trimmed, "Tip:")
    then
      local id, name = trimmed:match("^(%S+)%s+%-%s+(.+)$")
      if id then
        local parsed = parse_cursor_model_id(id)
        table.insert(models, {
          id = id,
          name = name,
          provider = "cursor",
          family = parsed.family,
          effort = parsed.effort,
          thinking = parsed.thinking,
          fast = parsed.fast,
        })
      end
    end
  end
  return models
end

local function build_cursor_families(models)
  local by_family = {}
  for _, model in ipairs(models) do
    local family_id = model.family or model.id
    if not by_family[family_id] then
      by_family[family_id] = {
        id = family_id,
        label = clean_family_label(model.name),
        variants = {},
      }
    end
    table.insert(by_family[family_id].variants, model)

    local candidate = clean_family_label(model.name)
    if #candidate < #by_family[family_id].label then
      by_family[family_id].label = candidate
    end
  end

  local families = {}
  for _, family in pairs(by_family) do
    table.insert(families, family)
  end
  table.sort(families, function(left, right)
    return left.label:lower() < right.label:lower()
  end)
  return families
end

local function effort_sort_key(effort)
  if effort == nil then
    return 0
  end
  return EFFORT_ORDER[effort] or 50
end

local function unique_efforts(variants)
  local seen = {}
  local efforts = {}
  for _, model in ipairs(variants) do
    local key = model.effort == nil and "__default__" or model.effort
    if not seen[key] then
      seen[key] = true
      table.insert(efforts, model.effort)
    end
  end
  table.sort(efforts, function(left, right)
    return effort_sort_key(left) < effort_sort_key(right)
  end)
  return efforts
end

local function filter_variants(variants, opts)
  local filtered = {}
  for _, model in ipairs(variants) do
    local effort_ok = true
    if opts.effort_selected then
      if opts.effort == nil then
        effort_ok = model.effort == nil
      else
        effort_ok = model.effort == opts.effort
      end
    end
    local thinking_ok = opts.thinking == nil or model.thinking == opts.thinking
    local fast_ok = opts.fast == nil or model.fast == opts.fast
    if effort_ok and thinking_ok and fast_ok then
      table.insert(filtered, model)
    end
  end
  return filtered
end

local function has_thinking_choice(variants)
  local has_true, has_false = false, false
  for _, model in ipairs(variants) do
    if model.thinking then
      has_true = true
    else
      has_false = true
    end
  end
  return has_true and has_false
end

local function has_fast_choice(variants)
  local has_true, has_false = false, false
  for _, model in ipairs(variants) do
    if model.fast then
      has_true = true
    else
      has_false = true
    end
  end
  return has_true and has_false
end

local function resolve_cursor_variant(variants, effort, thinking, fast)
  for _, model in ipairs(variants) do
    local effort_match = (effort == nil and model.effort == nil) or model.effort == effort
    if effort_match and model.thinking == thinking and model.fast == fast then
      return model
    end
  end
  -- Prefer exact thinking/fast, then closest effort
  local best = nil
  local best_score = math.huge
  for _, model in ipairs(variants) do
    local score = 0
    if model.thinking ~= thinking then score = score + 100 end
    if model.fast ~= fast then score = score + 50 end
    score = score + math.abs(effort_sort_key(model.effort) - effort_sort_key(effort))
    if score < best_score then
      best_score = score
      best = model
    end
  end
  return best or variants[1]
end

local function set_cursor_model(model, opts)
  opts = opts or {}
  local parsed = parse_cursor_model_id(model.id)
  state.current_model = {
    id = model.id,
    name = model.name or model.id,
    provider = "cursor",
    family = model.family or parsed.family,
    family_label = model.family_label or clean_family_label(model.name or model.id),
    effort = model.effort ~= nil and model.effort or parsed.effort,
    thinking = model.thinking ~= nil and model.thinking or parsed.thinking,
    fast = model.fast ~= nil and model.fast or parsed.fast,
  }
  if opts.persist ~= false then
    persist_cursor_model(state.current_model)
  end
  update_statusline()
  if not opts.silent then
    notify("cursor model: " .. (model_status_label(state.current_model) or model.id))
  end
end

local function ensure_cursor_model()
  if state.current_model and state.current_model.provider == "cursor" and state.current_model.id then
    return
  end
  if state.saved.cursor_model and state.saved.cursor_model.id then
    set_cursor_model(state.saved.cursor_model, { silent = true, persist = false })
    return
  end
  set_cursor_model({ id = "auto", name = "Auto", family = "auto", family_label = "Auto" }, { silent = true })
end

local function extract_cursor_tool(tool_call)
  if type(tool_call) ~= "table" then
    return nil, nil
  end
  for key, value in pairs(tool_call) do
    local tool_name = type(key) == "string" and key:match("^(%a+)ToolCall$")
    if tool_name and type(value) == "table" then
      return tool_name, value
    end
  end
  return nil, nil
end

local function append_cursor_assistant_text(text)
  if not text or text == "" then
    return
  end
  local accumulated = state.accumulated_text
  if accumulated == "" then
    state.accumulated_text = text
  elseif text:sub(1, #accumulated) == accumulated then
    -- Full message superseding streamed chunks
    state.accumulated_text = text
  elseif #text < #accumulated and accumulated:sub(1, #text) == text then
    -- Ignore stale shorter snapshot
    return
  else
    state.accumulated_text = accumulated .. text
  end
  state.status = "streaming"
  state.current_tool = nil
  state.live_status = nil
  update_statusline()
  render_accumulated_text()
end

local function handle_cursor_event(event)
  vim.schedule(function()
    if event.type == "system" and event.subtype == "init" then
      if event.session_id then
        state.cursor_session_id = event.session_id
        save_cursor_conversation()
      end
      if event.model and state.current_model then
        state.current_model.name = event.model
        update_statusline()
      elseif event.model then
        set_cursor_model({ id = "auto", name = event.model }, { silent = true, persist = false })
      end

    elseif event.type == "thinking" then
      if event.subtype == "delta" or event.subtype == "completed" then
        state.status = "thinking"
        update_statusline()
      end

    elseif event.type == "assistant" then
      local content = event.message and event.message.content
      if type(content) == "table" then
        for _, part in ipairs(content) do
          if part.type == "text" and part.text then
            append_cursor_assistant_text(part.text)
          end
        end
      end

    elseif event.type == "tool_call" then
      local tool_name, tool_data = extract_cursor_tool(event.tool_call)
      tool_name = tool_name or "tool"
      local args = tool_data and tool_data.args
      local args_str = format_tool_args(tool_name, args, tool_data and tool_data.description)
      local tool_id = event.call_id
        or event.tool_call_id
        or (tool_data and (tool_data.toolCallId or tool_data.id))

      if event.subtype == "started" then
        state.status = "tool"
        state.current_tool = tool_name
        state.live_status = nil
        update_statusline()
        begin_tool_display(tool_id, tool_name, args_str)

      elseif event.subtype == "completed" then
        local is_error = false
        if tool_data and tool_data.result then
          is_error = tool_data.result.success == nil and tool_data.result.error ~= nil
        end
        local status = is_error and "failed" or "done"
        finish_tool_display(tool_id, status, tool_name, args_str)

        if args and args.path and (tool_name == "edit" or tool_name == "write") then
          reload_modified_buffer(args.path)
        end
        if tool_data and tool_data.result and tool_data.result.success and tool_data.result.success.path then
          if tool_name == "edit" or tool_name == "write" then
            reload_modified_buffer(tool_data.result.success.path)
          end
        end

        state.current_tool = nil
        update_statusline()
      end

    elseif event.type == "result" then
      if event.session_id then
        state.cursor_session_id = event.session_id
        save_cursor_conversation()
      end
      if event.is_error or event.subtype == "error" then
        notify("cursor error: " .. (event.result or event.error or "unknown"), vim.log.levels.ERROR)
      end
    end
  end)
end

local function stop_job()
  if state.job_id then
    vim.fn.jobstop(state.job_id)
    state.job_id = nil
  end
end

local function prompt_cursor(message)
  local binary = cursor_binary()
  if not binary then
    notify("Cursor CLI (`agent`) not found in PATH", vim.log.levels.ERROR)
    return
  end

  if state.job_id then
    notify("Agent already running; abort first", vim.log.levels.WARN)
    return
  end

  ensure_cursor_model()
  ensure_sidebar({ focus_output = false })
  begin_agent_turn("── cursor processing... ──")
  update_statusline()

  local cmd = {
    binary,
    "-p",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace", vim.fn.getcwd(),
    "--model", state.current_model.id,
  }

  if state.cursor_session_id then
    table.insert(cmd, "--resume")
    table.insert(cmd, state.cursor_session_id)
  end

  table.insert(cmd, message)

  local stdout_remainder = ""

  state.job_id = vim.fn.jobstart(cmd, {
    on_stdout = function(_, data)
      for index, chunk in ipairs(data) do
        if index == 1 then
          stdout_remainder = stdout_remainder .. chunk
        else
          local line = stdout_remainder
          if line:sub(-1) == "\r" then
            line = line:sub(1, -2)
          end
          if line ~= "" then
            local ok, event = pcall(vim.json.decode, line)
            if ok and event then
              handle_cursor_event(event)
            end
          end
          stdout_remainder = chunk
        end
      end
    end,
    on_stderr = function(_, data)
      local msg = table.concat(data, "")
      if msg ~= "" then
        notify("cursor stderr: " .. msg, vim.log.levels.WARN)
      end
    end,
    on_exit = function(_, code)
      state.job_id = nil
      state.status = "idle"
      state.current_tool = nil
      update_statusline()
      vim.schedule(function()
        commit_agent_turn()
        if code ~= 0 then
          notify("cursor exited with code " .. code, vim.log.levels.WARN)
        end
      end)
    end,
    stdout_buffered = false,
    stderr_buffered = true,
  })

  if state.job_id <= 0 then
    state.job_id = nil
    state.status = "idle"
    update_statusline()
    notify("Failed to start cursor agent", vim.log.levels.ERROR)
  end
end

local function fetch_cursor_models(callback)
  local binary = cursor_binary()
  if not binary then
    notify("Cursor CLI (`agent`) not found in PATH", vim.log.levels.ERROR)
    return
  end

  if state.cursor_models and #state.cursor_models > 0 and state.cursor_families then
    callback(state.cursor_models, state.cursor_families)
    return
  end

  local lines = {}
  vim.fn.jobstart({ binary, "--list-models" }, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(lines, line)
        end
      end
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        if code ~= 0 then
          notify("Failed to list cursor models", vim.log.levels.ERROR)
          return
        end
        local models = parse_cursor_models(lines)
        if #models == 0 then
          notify("No cursor models available", vim.log.levels.WARN)
          return
        end
        state.cursor_models = models
        state.cursor_families = build_cursor_families(models)
        callback(models, state.cursor_families)
      end)
    end,
  })
end

local function finish_cursor_model_selection(family, effort, thinking, fast)
  local model = resolve_cursor_variant(family.variants, effort, thinking, fast)
  if not model then
    notify("No matching cursor model variant", vim.log.levels.WARN)
    return
  end
  model = vim.tbl_extend("force", {}, model, {
    family_label = family.label,
  })
  set_cursor_model(model)
end

local function cursor_selection_state(path)
  local family = path.family and path.family.value
  if not family then
    return nil
  end

  local effort = path.effort and path.effort.value
  local thinking = path.thinking and path.thinking.value
  local fast = path.fast and path.fast.value
  local variants = family.variants

  if path.effort then
    variants = filter_variants(variants, {
      effort_selected = true,
      effort = effort,
    })
  end
  if path.thinking then
    variants = filter_variants(variants, {
      effort_selected = path.effort ~= nil,
      effort = effort,
      thinking = thinking,
    })
  end

  return {
    family = family,
    effort = effort,
    thinking = thinking,
    fast = fast,
    variants = variants,
  }
end

local function next_cursor_column(path)
  local selected = cursor_selection_state(path)
  if not selected then
    return nil
  end

  if not path.effort then
    local efforts = unique_efforts(selected.family.variants)
    if #efforts > 1 then
      local items = {}
      for _, effort in ipairs(efforts) do
        table.insert(items, {
          label = effort == nil and "Default" or (EFFORT_LABELS[effort] or effort),
          value = effort,
          key = "effort",
        })
      end
      return { key = "effort", title = "Effort", items = items }
    end
    path.effort = {
      label = efforts[1] == nil and "Default" or (EFFORT_LABELS[efforts[1]] or efforts[1]),
      value = efforts[1],
      auto = true,
    }
    selected = cursor_selection_state(path)
  end

  if not path.thinking then
    if has_thinking_choice(selected.variants) then
      return {
        key = "thinking",
        title = "Thinking",
        items = {
          { label = "Thinking off", value = false, key = "thinking" },
          { label = "Thinking on", value = true, key = "thinking" },
        },
      }
    end
    local thinking = selected.variants[1] and selected.variants[1].thinking or false
    path.thinking = {
      label = thinking and "Thinking on" or "Thinking off",
      value = thinking,
      auto = true,
    }
    selected = cursor_selection_state(path)
  end

  if not path.fast then
    if has_fast_choice(selected.variants) then
      return {
        key = "fast",
        title = "Fast",
        items = {
          { label = "Normal", value = false, key = "fast" },
          { label = "Fast", value = true, key = "fast" },
        },
      }
    end
    local fast = selected.variants[1] and selected.variants[1].fast or false
    path.fast = {
      label = fast and "Fast" or "Normal",
      value = fast,
      auto = true,
    }
  end

  return nil
end

local function open_miller_picker(root_column, resolve_next, on_confirm)
  local path = {}
  local columns = {
    {
      key = root_column.key,
      title = root_column.title,
      items = root_column.items,
      cursor = 1,
      selected = nil,
      scroll = 0,
    },
  }
  local active = 1
  local ns = vim.api.nvim_create_namespace("agent_miller_picker")
  local buf = vim.api.nvim_create_buf(false, true)
  local win

  -- Telescope-style centered modal; columns fill this modal, not the whole editor.
  local win_width = math.max(48, math.floor(vim.o.columns * 0.8))
  local win_height = math.max(14, math.floor(vim.o.lines * 0.7))
  win_width = math.min(win_width, vim.o.columns - 4)
  win_height = math.min(win_height, vim.o.lines - 4)
  local list_height = math.max(5, win_height - 5)
  local win_row = math.floor((vim.o.lines - win_height) / 2)
  local win_col = math.floor((vim.o.columns - win_width) / 2)

  local function close_picker()
    if win and vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
    if buf and vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_buf_delete(buf, { force = true })
    end
  end

  local function ensure_scroll(column)
    if column.cursor <= column.scroll then
      column.scroll = math.max(0, column.cursor - 1)
    elseif column.cursor > column.scroll + list_height then
      column.scroll = column.cursor - list_height
    end
  end

  local function visible_columns()
    local visible = {}
    for index, column in ipairs(columns) do
      if index < active then
        local selected = column.items[column.selected]
        table.insert(visible, {
          title = column.title,
          lines = { selected and selected.label or "" },
          cursor = 1,
          committed = true,
        })
      elseif index == active then
        ensure_scroll(column)
        local lines = {}
        local start_index = column.scroll + 1
        local end_index = math.min(#column.items, column.scroll + list_height)
        for item_index = start_index, end_index do
          table.insert(lines, column.items[item_index].label)
        end
        -- Keep column height stable for the full window even with few options
        while #lines < list_height do
          table.insert(lines, "")
        end
        table.insert(visible, {
          title = column.title,
          lines = lines,
          cursor = column.cursor - column.scroll,
          committed = false,
        })
      end
    end
    return visible
  end

  local function pad(text, width)
    local visible_width = vim.fn.strdisplaywidth(text)
    if visible_width >= width then
      return vim.fn.strcharpart(text, 0, width)
    end
    return text .. string.rep(" ", width - visible_width)
  end

  local function render()
    local visible = visible_columns()
    local col_widths = {}
    local separator_width = 3 -- " │ "
    local reserved = separator_width * math.max(#visible - 1, 0)

    for index, column in ipairs(visible) do
      local width = vim.fn.strdisplaywidth(column.title)
      for _, line in ipairs(column.lines) do
        if line ~= "" then
          width = math.max(width, vim.fn.strdisplaywidth(line))
        end
      end
      -- +4 leaves room for selection prefix ("▸ "/"• "/"  ")
      col_widths[index] = math.max(width + 4, 12)
    end

    -- Stretch columns across the full window width (active column absorbs remainder)
    local content_width = win_width - 2
    local used = reserved
    for index = 1, #visible - 1 do
      used = used + col_widths[index]
    end
    if #visible > 0 then
      col_widths[#visible] = math.max(col_widths[#visible], content_width - used)
    end

    -- If still overflowing (many committed columns), shrink proportionally
    used = reserved
    for _, width in ipairs(col_widths) do
      used = used + width
    end
    if used > content_width then
      local shrinkable = used - reserved
      local target = content_width - reserved
      for index, width in ipairs(col_widths) do
        col_widths[index] = math.max(10, math.floor(width * target / shrinkable))
      end
    end

    local lines = {}
    local header_parts = {}
    for index, column in ipairs(visible) do
      table.insert(header_parts, pad(column.title, col_widths[index]))
    end
    table.insert(lines, table.concat(header_parts, " │ "))

    local rule_parts = {}
    for index, _ in ipairs(visible) do
      table.insert(rule_parts, string.rep("─", col_widths[index]))
    end
    table.insert(lines, table.concat(rule_parts, "─┼─"))

    for row = 1, list_height do
      local parts = {}
      for index, column in ipairs(visible) do
        local text = column.lines[row] or ""
        if text ~= "" then
          if not column.committed and row == column.cursor then
            text = "▸ " .. text
          elseif column.committed and row == 1 then
            text = "• " .. text
          else
            text = "  " .. text
          end
        end
        parts[index] = pad(text, col_widths[index])
      end
      table.insert(lines, table.concat(parts, " │ "))
    end

    table.insert(lines, pad("", content_width))
    table.insert(lines, pad("C-n/C-p move  C-y/⏎ select  C-h/h back  esc cancel", content_width))

    -- Ensure every line spans the modal width so columns fill the popup
    for index, line in ipairs(lines) do
      lines[index] = pad(line, content_width)
    end

    if not win or not vim.api.nvim_win_is_valid(win) then
      win = vim.api.nvim_open_win(buf, true, {
        relative = "editor",
        style = "minimal",
        border = "rounded",
        title = " Cursor model ",
        title_pos = "center",
        width = win_width,
        height = win_height,
        row = win_row,
        col = win_col,
        zindex = 60,
      })
      vim.wo[win].wrap = false
      vim.wo[win].cursorline = false
      vim.wo[win].number = false
      vim.wo[win].relativenumber = false
      vim.wo[win].signcolumn = "no"
      vim.wo[win].foldcolumn = "0"
      vim.wo[win].list = false
    else
      vim.api.nvim_win_set_config(win, {
        relative = "editor",
        width = win_width,
        height = win_height,
        row = win_row,
        col = win_col,
      })
    end

    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

    local cursor_row = 2 + (visible[#visible] and visible[#visible].cursor or 1)
    cursor_row = math.min(cursor_row, #lines)
    vim.api.nvim_win_set_cursor(win, { cursor_row, 0 })
    vim.api.nvim_buf_add_highlight(buf, ns, "Visual", cursor_row - 1, 0, -1)
  end

  local function sync_path_from_columns()
    path = {}
    for index = 1, active - 1 do
      local column = columns[index]
      local item = column.items[column.selected]
      if item then
        path[column.key] = {
          label = item.label,
          value = item.value,
        }
      end
    end
  end

  local function confirm_current()
    local column = columns[active]
    local item = column.items[column.cursor]
    if not item then
      return
    end

    column.selected = column.cursor
    sync_path_from_columns()
    path[column.key] = {
      label = item.label,
      value = item.value,
    }

    local next_column = resolve_next(path)
    if next_column == nil then
      if not cursor_selection_state(path) then
        return
      end
      close_picker()
      on_confirm(path)
      return
    end

    while #columns > active do
      table.remove(columns)
    end
    table.insert(columns, {
      key = next_column.key,
      title = next_column.title,
      items = next_column.items,
      cursor = 1,
      selected = nil,
      scroll = 0,
    })
    active = #columns
    render()
  end

  local function go_back()
    if active == 1 then
      close_picker()
      return
    end
    table.remove(columns)
    active = #columns
    columns[active].selected = nil
    sync_path_from_columns()
    render()
  end

  local function move_cursor(delta)
    local column = columns[active]
    column.cursor = math.max(1, math.min(#column.items, column.cursor + delta))
    render()
  end

  local function jump_cursor(target)
    local column = columns[active]
    if target == "top" then
      column.cursor = 1
    elseif target == "bottom" then
      column.cursor = #column.items
    end
    render()
  end

  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].filetype = "agent-miller-picker"
  vim.bo[buf].modifiable = false
  vim.bo[buf].swapfile = false

  local map_opts = { buffer = buf, nowait = true, silent = true, noremap = true }
  local function map(lhs, rhs)
    vim.keymap.set("n", lhs, rhs, map_opts)
  end

  map("j", function() move_cursor(1) end)
  map("k", function() move_cursor(-1) end)
  map("<Down>", function() move_cursor(1) end)
  map("<Up>", function() move_cursor(-1) end)
  map("<C-n>", function() move_cursor(1) end)
  map("<C-p>", function() move_cursor(-1) end)
  map("<C-j>", function() move_cursor(1) end)
  map("<C-k>", function() move_cursor(-1) end)
  map("<C-d>", function() move_cursor(math.floor(list_height / 2)) end)
  map("<C-u>", function() move_cursor(-math.floor(list_height / 2)) end)
  map("<PageDown>", function() move_cursor(list_height) end)
  map("<PageUp>", function() move_cursor(-list_height) end)
  map("gg", function() jump_cursor("top") end)
  map("G", function() jump_cursor("bottom") end)

  map("l", confirm_current)
  map("<CR>", confirm_current)
  map("<Tab>", confirm_current)
  map("<C-y>", confirm_current)
  map("<C-l>", confirm_current)

  map("h", go_back)
  map("<BS>", go_back)
  map("<S-Tab>", go_back)
  map("<C-h>", go_back)
  map("<Left>", go_back)
  map("<Right>", confirm_current)

  map("q", close_picker)
  map("<Esc>", close_picker)
  map("<C-c>", close_picker)

  render()
end

local function pick_cursor_model()
  fetch_cursor_models(function(_, families)
    local items = {}
    for _, family in ipairs(families) do
      table.insert(items, {
        label = family.label,
        value = family,
        key = "family",
      })
    end

    open_miller_picker({
      key = "family",
      title = "Model",
      items = items,
    }, next_cursor_column, function(path)
      local selected = cursor_selection_state(path)
      if not selected then
        return
      end
      finish_cursor_model_selection(
        selected.family,
        path.effort and path.effort.value or selected.effort,
        path.thinking and path.thinking.value or selected.thinking,
        path.fast and path.fast.value or selected.fast
      )
    end)
  end)
end

local function cycle_cursor_model()
  fetch_cursor_models(function(_, families)
    ensure_cursor_model()
    local current_family = state.current_model.family or parse_cursor_model_id(state.current_model.id).family
    local current_index = 1
    for index, family in ipairs(families) do
      if family.id == current_family then
        current_index = index
        break
      end
    end
    local next_family = families[(current_index % #families) + 1]
    local model = resolve_cursor_variant(
      next_family.variants,
      state.current_model.effort,
      state.current_model.thinking and true or false,
      state.current_model.fast and true or false
    )
    if model then
      model = vim.tbl_extend("force", {}, model, { family_label = next_family.label })
      set_cursor_model(model)
    end
  end)
end

-- ─── Provider ──────────────────────────────────────────────────────────────────

local function stop_provider()
  if state.provider == "pi" then
    if state.job_id then
      stop_job()
      notify("pi stopped")
    end
  else
    if state.job_id then
      stop_job()
      notify("cursor aborted")
    end
  end
  state.status = "idle"
  state.current_tool = nil
  update_statusline()
end

local function start()
  if state.provider == "pi" then
    start_pi()
  else
    local binary = cursor_binary()
    if not binary then
      notify("Cursor CLI (`agent`) not found in PATH", vim.log.levels.ERROR)
      return
    end
    ensure_cursor_model()
    state.status = "idle"
    update_statusline()
    notify("cursor ready (" .. state.current_model.id .. ")")
  end
end

local function stop()
  stop_provider()
end

local function set_provider(provider, opts)
  opts = opts or {}
  if provider ~= "pi" and provider ~= "cursor" then
    notify("Unknown provider: " .. tostring(provider), vim.log.levels.ERROR)
    return
  end
  if state.provider == provider and not opts.force then
    notify("Already using " .. provider)
    return
  end

  stop_provider()
  state.provider = provider
  state.current_model = nil
  state.current_tool = nil
  state.saved.provider = provider
  if opts.persist ~= false then
    save_settings()
  end

  if provider == "cursor" then
    ensure_cursor_model()
    if not opts.silent then
      notify("provider: cursor")
    end
  else
    state.cursor_session_id = nil
    state.conversation_id = nil
    if not opts.silent then
      notify("provider: pi")
    end
    start_pi()
  end
  update_statusline()
end

local function pick_provider()
  local items = {}
  for _, provider in ipairs(PROVIDERS) do
    local suffix = provider == state.provider and " (current)" or ""
    table.insert(items, {
      display = provider .. suffix,
      provider = provider,
    })
  end
  vim.ui.select(items, {
    prompt = "Select agent provider:",
    format_item = function(item) return item.display end,
  }, function(choice)
    if choice then
      set_provider(choice.provider)
    end
  end)
end

-- ─── Prompt Functions ──────────────────────────────────────────────────────────

local function truncate_display(text, max_chars)
  max_chars = max_chars or 800
  if not text or #text <= max_chars then
    return text
  end
  return text:sub(1, max_chars) .. "\n… (" .. tostring(#text) .. " chars)"
end

local function prompt(message, opts)
  opts = opts or {}
  if not message or message == "" then
    notify("Empty prompt", vim.log.levels.WARN)
    return
  end

  ensure_sidebar({ focus_output = false })
  append_user_message(opts.display or truncate_display(message))

  if state.provider == "cursor" then
    prompt_cursor(message)
  else
    send_pi_command({ type = "prompt", message = message })
  end
end

local function prompt_with_buffer(message, source_buf)
  source_buf = source_buf or vim.api.nvim_get_current_buf()
  if state.output_buf and source_buf == state.output_buf then
    source_buf = vim.fn.bufnr("#")
  end
  if state.input_buf and source_buf == state.input_buf then
    source_buf = vim.fn.bufnr("#")
  end
  if not source_buf or source_buf < 1 or not vim.api.nvim_buf_is_valid(source_buf) then
    notify("No buffer available for context", vim.log.levels.WARN)
    return
  end

  local buf_lines = vim.api.nvim_buf_get_lines(source_buf, 0, -1, false)
  local buf_content = table.concat(buf_lines, "\n")
  local file = vim.api.nvim_buf_get_name(source_buf)
  local filetype = vim.bo[source_buf].filetype

  local full_prompt = string.format(
    "I'm working on file: `%s` (filetype: %s)\n\nCurrent content:\n```%s\n%s\n```\n\n%s",
    file, filetype, filetype, buf_content, message
  )
  local display = string.format("📄 %s\n%s", file ~= "" and file or "[buffer]", message)
  prompt(full_prompt, { display = display })
end

local function capture_visual_selection()
  local buf = vim.api.nvim_get_current_buf()
  local start_pos, end_pos
  local mode = vim.fn.mode()
  if mode == "v" or mode == "V" or mode == "\22" then
    start_pos = vim.fn.getpos("v")
    end_pos = vim.fn.getpos(".")
  else
    start_pos = vim.fn.getpos("'<")
    end_pos = vim.fn.getpos("'>")
  end

  if start_pos[2] > end_pos[2] or (start_pos[2] == end_pos[2] and start_pos[3] > end_pos[3]) then
    start_pos, end_pos = end_pos, start_pos
  end

  local lines = vim.api.nvim_buf_get_lines(buf, start_pos[2] - 1, end_pos[2], false)
  if #lines == 0 then
    return nil
  end

  if mode == "V" then
    -- linewise: keep full lines
  elseif #lines == 1 then
    lines[1] = lines[1]:sub(start_pos[3], end_pos[3])
  else
    lines[1] = lines[1]:sub(start_pos[3])
    lines[#lines] = lines[#lines]:sub(1, end_pos[3])
  end

  return {
    buf = buf,
    file = vim.api.nvim_buf_get_name(buf),
    filetype = vim.bo[buf].filetype,
    start_line = start_pos[2],
    end_line = end_pos[2],
    text = table.concat(lines, "\n"),
  }
end

local function prompt_with_selection(message, selection)
  selection = selection or state.pending_selection or capture_visual_selection()
  state.pending_selection = nil

  if not selection or not selection.text or selection.text == "" then
    notify("No selection", vim.log.levels.WARN)
    return
  end

  local full_prompt = string.format(
    "From file `%s` (lines %d-%d):\n```%s\n%s\n```\n\n%s",
    selection.file, selection.start_line, selection.end_line, selection.filetype, selection.text, message
  )
  local display = string.format(
    "✂ %s:%d-%d\n%s",
    selection.file ~= "" and selection.file or "[buffer]",
    selection.start_line,
    selection.end_line,
    message
  )
  prompt(full_prompt, { display = display })
end

local function focus_ask(with_context)
  if state.provider == "pi" then
    if not state.job_id then
      start_pi()
    end
  else
    ensure_cursor_model()
  end

  local current_buf = vim.api.nvim_get_current_buf()
  if with_context == "selection" and not state.pending_selection then
    state.pending_selection = capture_visual_selection()
  end
  if with_context == "buffer" then
    if current_buf ~= state.output_buf and current_buf ~= state.input_buf then
      state.pending_buffer = current_buf
    end
  end

  state.pending_context = with_context
  ensure_sidebar({ focus_input = true })
  update_input_placeholder()
end

local function prompt_input(with_context)
  focus_ask(with_context)
end

submit_input = function()
  if not state.input_buf or not vim.api.nvim_buf_is_valid(state.input_buf) then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false)
  while #lines > 0 and vim.trim(lines[#lines]) == "" do
    table.remove(lines)
  end
  while #lines > 0 and vim.trim(lines[1]) == "" do
    table.remove(lines, 1)
  end
  local input = table.concat(lines, "\n")
  if vim.trim(input) == "" then
    return
  end

  if state.provider == "cursor" and state.job_id then
    notify("Agent already running; abort first", vim.log.levels.WARN)
    return
  end

  vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, {})
  vim.cmd("stopinsert")
  if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
    vim.api.nvim_set_current_win(state.output_win)
  end

  local ctx = state.pending_context
  state.pending_context = nil
  update_input_placeholder()

  if ctx == "buffer" then
    local source = state.pending_buffer
    state.pending_buffer = nil
    prompt_with_buffer(input, source)
  elseif ctx == "selection" then
    prompt_with_selection(input)
  else
    prompt(input)
  end
end

-- ─── File Picker ───────────────────────────────────────────────────────────────

local function pick_modified_file()
  if #state.modified_files == 0 then
    notify("No files modified by agent", vim.log.levels.INFO)
    return
  end

  local seen = {}
  local unique = {}
  for _, file_path in ipairs(state.modified_files) do
    if not seen[file_path] then
      seen[file_path] = true
      table.insert(unique, file_path)
    end
  end

  vim.ui.select(unique, { prompt = "Open file modified by agent:" }, function(choice)
    if choice then
      vim.cmd("edit " .. vim.fn.fnameescape(choice))
    end
  end)
end

-- ─── Model ─────────────────────────────────────────────────────────────────────

local function show_model()
  if state.current_model then
    local model = state.current_model
    local lines = {
      "Provider: " .. state.provider,
      "Model: " .. (model_status_label(model) or model.name or model.id or "unknown"),
      "ID: " .. (model.id or "unknown"),
    }
    if state.provider == "cursor" then
      table.insert(lines, "Family: " .. (model.family_label or model.family or "?"))
      table.insert(lines, "Effort: " .. (model.effort and (EFFORT_LABELS[model.effort] or model.effort) or "Default"))
      table.insert(lines, "Thinking: " .. (model.thinking and "on" or "off"))
      table.insert(lines, "Fast: " .. (model.fast and "on" or "off"))
    elseif model.provider then
      table.insert(lines, "LLM provider: " .. model.provider)
    end
    notify(table.concat(lines, "\n"))
  else
    notify("No model info available", vim.log.levels.WARN)
  end
end

local function cycle_model()
  if state.provider == "cursor" then
    cycle_cursor_model()
  else
    send_pi_command({ type = "cycle_model" })
  end
end

local function pick_model()
  if state.provider == "cursor" then
    pick_cursor_model()
    return
  end

  if not state.job_id then
    start_pi()
  end
  if not state.job_id then
    notify("Pi is not running", vim.log.levels.ERROR)
    return
  end

  local req_id = "pick_model_" .. tostring(os.time())
  state._pick_model_id = req_id
  send_pi_command({ type = "get_available_models", id = req_id })
end

local function new_session()
  if state.provider == "cursor" then
    if state.job_id then
      notify("Abort current cursor run first", vim.log.levels.WARN)
      return
    end
    save_cursor_conversation()
    state.cursor_session_id = nil
    state.conversation_id = nil
    state.modified_files = {}
    clear_chat()
    ensure_sidebar({ focus_input = true })
    notify("new cursor session")
  else
    send_pi_command({ type = "new_session" })
    state.pi_session_file = nil
    state.pi_session_id = nil
    clear_chat()
    ensure_sidebar({ focus_input = true })
    notify("new pi session started")
  end
end

local function resume_cursor_conversation(item)
  if state.job_id then
    notify("Abort current cursor run first", vim.log.levels.WARN)
    return
  end
  if state.provider ~= "cursor" then
    set_provider("cursor", { silent = true })
  end
  state.conversation_id = item.id
  state.cursor_session_id = item.session_id
  state.chat_lines = item.chat_lines or {}
  state.turn_lines = {}
  state.live_status = nil
  state.accumulated_text = ""
  if item.model and item.model.id then
    set_cursor_model(item.model, { silent = true, persist = false })
  else
    ensure_cursor_model()
  end
  ensure_sidebar({ focus_input = true })
  render_chat()
  local resume_hint = item.session_id and " (continue enabled)" or " (transcript only; no session id)"
  notify("resumed cursor conversation" .. resume_hint)
end

local function resume_pi_session(item)
  if state.provider ~= "pi" then
    set_provider("pi", { silent = true })
  end
  if not state.job_id then
    start_pi()
  end
  if not state.job_id then
    notify("Pi is not running", vim.log.levels.ERROR)
    return
  end
  state.pi_session_file = item.path
  state.pi_session_id = item.id
  local req_id = "switch_session_" .. tostring(os.time())
  state._switch_session_id = req_id
  send_pi_command({ type = "switch_session", id = req_id, sessionPath = item.path })
end

local function resume_conversation()
  local items = {}
  for _, item in ipairs(list_cursor_conversations()) do
    table.insert(items, item)
  end
  for _, item in ipairs(list_pi_sessions()) do
    table.insert(items, item)
  end
  table.sort(items, function(left, right)
    return (left.updated_at or 0) > (right.updated_at or 0)
  end)

  if #items == 0 then
    notify("No previous conversations for this directory", vim.log.levels.INFO)
    return
  end

  vim.ui.select(items, {
    prompt = "Resume conversation:",
    format_item = function(item)
      local when = format_relative_time(item.updated_at)
      local mark = item.provider == "cursor" and "cursor" or "pi"
      local cont = ""
      if item.provider == "cursor" and not item.session_id then
        cont = " [view only]"
      end
      return string.format("[%s] %s  %s%s", mark, when, item.title or "(untitled)", cont)
    end,
  }, function(choice)
    if not choice then
      return
    end
    if choice.provider == "cursor" then
      resume_cursor_conversation(choice)
    else
      resume_pi_session(choice)
    end
  end)
end

-- ─── Abort ─────────────────────────────────────────────────────────────────────

local function abort()
  if state.provider == "cursor" then
    if state.job_id then
      stop_job()
      state.status = "idle"
      state.current_tool = nil
      update_statusline()
      notify("cursor abort sent")
    else
      notify("No cursor run in progress")
    end
  else
    send_pi_command({ type = "abort" })
    notify("pi abort sent")
  end
end

-- ─── Commands and Keymaps ──────────────────────────────────────────────────────

local function setup()
  load_settings()
  setup_highlights()
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("agent-chat-highlights", { clear = true }),
    callback = setup_highlights,
  })

  if state.provider == "cursor" then
    ensure_cursor_model()
  elseif state.saved.pi_model then
    state.current_model = {
      id = state.saved.pi_model.id,
      name = state.saved.pi_model.name,
      provider = state.saved.pi_model.provider,
    }
  end
  update_statusline()

  vim.api.nvim_create_user_command("PiStart", start, { desc = "Start agent provider" })
  vim.api.nvim_create_user_command("PiStop", stop, { desc = "Stop agent provider" })
  vim.api.nvim_create_user_command("PiAbort", abort, { desc = "Abort current agent operation" })
  vim.api.nvim_create_user_command("PiToggle", function()
    if state.job_id then stop() else start() end
  end, { desc = "Toggle agent" })

  vim.api.nvim_create_user_command("PiPrompt", function(opts)
    prompt(opts.args)
  end, { nargs = "+", desc = "Send prompt to agent" })

  vim.api.nvim_create_user_command("PiAsk", function()
    focus_ask(nil)
  end, { desc = "Open agent sidebar and focus ask input" })

  vim.api.nvim_create_user_command("PiAskBuffer", function()
    focus_ask("buffer")
  end, { desc = "Open agent ask input with current buffer as context" })

  vim.api.nvim_create_user_command("PiAskSelection", function()
    focus_ask("selection")
  end, { desc = "Open agent ask input with visual selection as context" })

  vim.api.nvim_create_user_command("PiOutput", create_output_window, { desc = "Show agent chat sidebar" })
  vim.api.nvim_create_user_command("PiClose", close_output, { desc = "Close agent chat sidebar" })
  vim.api.nvim_create_user_command("PiFiles", pick_modified_file, { desc = "Pick a file modified by agent" })

  vim.api.nvim_create_user_command("PiProvider", pick_provider, { desc = "Pick agent provider (pi/cursor)" })
  vim.api.nvim_create_user_command("PiSetProvider", function(opts)
    set_provider(opts.args)
  end, {
    nargs = 1,
    complete = function()
      return PROVIDERS
    end,
    desc = "Set agent provider (pi/cursor)",
  })

  vim.api.nvim_create_user_command("PiModel", show_model, { desc = "Show current agent model" })
  vim.api.nvim_create_user_command("PiCycleModel", cycle_model, { desc = "Cycle to next agent model" })
  vim.api.nvim_create_user_command("PiPickModel", pick_model, { desc = "Pick agent model" })

  vim.api.nvim_create_user_command("PiNewSession", new_session, { desc = "Start new agent session" })
  vim.api.nvim_create_user_command("PiResume", resume_conversation, { desc = "Resume a previous agent conversation" })

  vim.keymap.set("n", "<leader><C-p>s", start, { desc = "Agent: Start" })
  vim.keymap.set("n", "<leader><C-p>q", stop, { desc = "Agent: Stop" })
  vim.keymap.set("n", "<leader><C-p>a", function() focus_ask(nil) end, { desc = "Agent: Ask" })
  vim.keymap.set("n", "<leader><C-p>b", function() focus_ask("buffer") end, { desc = "Agent: Ask with buffer" })
  vim.keymap.set("v", "<leader><C-p>a", function()
    state.pending_selection = capture_visual_selection()
    focus_ask("selection")
  end, { desc = "Agent: Ask with selection" })
  vim.keymap.set("n", "<leader><C-p>x", abort, { desc = "Agent: Abort" })
  vim.keymap.set("n", "<leader><C-p>o", create_output_window, { desc = "Agent: Show output" })
  vim.keymap.set("n", "<leader><C-p>c", close_output, { desc = "Agent: Close output" })
  vim.keymap.set("n", "<leader><C-p>f", pick_modified_file, { desc = "Agent: Pick modified file" })
  vim.keymap.set("n", "<leader><C-p>p", pick_provider, { desc = "Agent: Pick provider" })
  vim.keymap.set("n", "<leader><C-p>m", pick_model, { desc = "Agent: Pick model" })
  vim.keymap.set("n", "<leader><C-p>M", cycle_model, { desc = "Agent: Cycle model" })
  vim.keymap.set("n", "<leader><C-p>n", new_session, { desc = "Agent: New session" })
  vim.keymap.set("n", "<leader><C-p>r", resume_conversation, { desc = "Agent: Resume conversation" })

  vim.opt.autoread = true
  vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter" }, {
    pattern = "*",
    command = "checktime",
  })

  vim.g.pi_status = "💤 " .. state.provider .. ": idle"
  refresh_input_winbar()
end

-- ─── Module Exports ────────────────────────────────────────────────────────────

M.setup = setup
M.start = start
M.stop = stop
M.prompt = prompt
M.prompt_with_buffer = prompt_with_buffer
M.prompt_with_selection = prompt_with_selection
M.abort = abort
M.close_output = close_output
M.pick_modified_file = pick_modified_file
M.show_model = show_model
M.cycle_model = cycle_model
M.pick_model = pick_model
M.pick_provider = pick_provider
M.set_provider = set_provider
M.input_winbar = input_winbar
M.focus_ask = focus_ask
M.resume_conversation = resume_conversation
M.state = state

return M
