-- Pi coding agent integration for Neovim
-- Communicates with pi via RPC mode (JSON over stdin/stdout)

local M = {}

-- State
local state = {
  job_id = nil,
  output_buf = nil,
  output_win = nil,
  accumulated_text = "",
  status = "idle", -- idle, thinking, streaming, tool
  current_tool = nil,
  modified_files = {},
  turn_count = 0,
}

-- ─── Helpers ───────────────────────────────────────────────────────────────────

local function notify(msg, level)
  vim.schedule(function()
    vim.notify("pi: " .. msg, level or vim.log.levels.INFO)
  end)
end

local function set_buf_lines(buf, lines)
  if buf and vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_set_option(buf, "modifiable", true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(buf, "modifiable", false)
  end
end

local function append_buf_lines(buf, lines)
  if buf and vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_set_option(buf, "modifiable", true)
    vim.api.nvim_buf_set_lines(buf, -1, -1, false, lines)
    vim.api.nvim_buf_set_option(buf, "modifiable", false)
    -- Auto-scroll to bottom
    if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
      local line_count = vim.api.nvim_buf_line_count(buf)
      vim.api.nvim_win_set_cursor(state.output_win, { line_count, 0 })
    end
  end
end

local function update_statusline()
  vim.schedule(function()
    local icon = ({
      idle = "💤",
      thinking = "🧠",
      streaming = "✍️ ",
      tool = "🔧",
    })[state.status] or "❓"
    vim.g.pi_status = icon .. " pi: " .. state.status
    if state.current_tool then
      vim.g.pi_status = vim.g.pi_status .. " (" .. state.current_tool .. ")"
    end
    vim.cmd("redrawstatus")
  end)
end

-- ─── Output Window ─────────────────────────────────────────────────────────────

local function create_output_window()
  if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
    vim.api.nvim_set_current_win(state.output_win)
    return
  end

  -- Create buffer
  state.output_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(state.output_buf, "pi://output")
  vim.api.nvim_buf_set_option(state.output_buf, "buftype", "nofile")
  vim.api.nvim_buf_set_option(state.output_buf, "filetype", "markdown")
  vim.api.nvim_buf_set_option(state.output_buf, "modifiable", false)

  -- Open in a vertical split on the right
  vim.cmd("botright vsplit")
  state.output_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.output_win, state.output_buf)
  vim.api.nvim_win_set_width(state.output_win, 80)
  vim.api.nvim_win_set_option(state.output_win, "wrap", true)
  vim.api.nvim_win_set_option(state.output_win, "linebreak", true)
  vim.api.nvim_win_set_option(state.output_win, "number", false)
  vim.api.nvim_win_set_option(state.output_win, "relativenumber", false)
  vim.api.nvim_win_set_option(state.output_win, "signcolumn", "no")

  -- Keymaps for the output buffer
  vim.api.nvim_buf_set_keymap(state.output_buf, "n", "q", "<cmd>lua require('custom.pi').close_output()<CR>",
    { noremap = true, silent = true })
end

local function close_output()
  if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
    vim.api.nvim_win_close(state.output_win, true)
    state.output_win = nil
  end
end

-- ─── RPC Communication ─────────────────────────────────────────────────────────

local start -- forward declaration

local function ensure_running()
  if not state.job_id then
    start()
  end
end

local function send_command(cmd)
  ensure_running()
  if not state.job_id then
    notify("Failed to start pi", vim.log.levels.ERROR)
    return false
  end
  local json = vim.json.encode(cmd) .. "\n"
  vim.fn.chansend(state.job_id, json)
  return true
end

local function handle_event(event)
  vim.schedule(function()
    if event.type == "response" then
      if not event.success then
        notify("Error: " .. (event.error or "unknown"), vim.log.levels.ERROR)
      end
      return
    end

    if event.type == "agent_start" then
      state.accumulated_text = ""
      state.status = "thinking"
      state.turn_count = 0
      state.modified_files = {}
      update_statusline()
      create_output_window()
      set_buf_lines(state.output_buf, { "── pi processing... ──", "" })

    elseif event.type == "message_update" then
      local delta = event.assistantMessageEvent
      if not delta then return end

      if delta.type == "text_delta" then
        state.status = "streaming"
        state.current_tool = nil
        update_statusline()
        state.accumulated_text = state.accumulated_text .. delta.delta
        local lines = vim.split(state.accumulated_text, "\n", { plain = true })
        set_buf_lines(state.output_buf, lines)
        -- Auto-scroll to bottom
        if state.output_win and vim.api.nvim_win_is_valid(state.output_win) then
          local line_count = vim.api.nvim_buf_line_count(state.output_buf)
          vim.api.nvim_win_set_cursor(state.output_win, { line_count, 0 })
        end
      elseif delta.type == "thinking_delta" then
        state.status = "thinking"
        update_statusline()
      end

    elseif event.type == "tool_execution_start" then
      state.status = "tool"
      state.current_tool = event.toolName
      update_statusline()

      local args_str = ""
      if event.toolName == "bash" and event.args and event.args.command then
        args_str = event.args.command
      elseif event.args and event.args.path then
        args_str = event.args.path
      end

      append_buf_lines(state.output_buf, {
        "",
        "🔧 " .. event.toolName .. ": " .. args_str,
      })

    elseif event.type == "tool_execution_end" then
      local icon = event.isError and "❌" or "✅"
      append_buf_lines(state.output_buf, { icon .. " " .. event.toolName .. " done" })

      -- Track modified files and auto-reload
      if event.toolName == "write" or event.toolName == "edit" then
        local path = event.args and event.args.path
        if path then
          table.insert(state.modified_files, path)
          for _, b in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_is_loaded(b) then
              local bname = vim.api.nvim_buf_get_name(b)
              if bname == path then
                vim.api.nvim_buf_call(b, function()
                  vim.cmd("checktime")
                end)
              end
            end
          end
        end
      end

      state.current_tool = nil
      update_statusline()

    elseif event.type == "turn_start" then
      state.turn_count = state.turn_count + 1

    elseif event.type == "agent_end" then
      state.status = "idle"
      state.current_tool = nil
      update_statusline()
      append_buf_lines(state.output_buf, { "", "── done ──" })

      if #state.modified_files > 0 then
        append_buf_lines(state.output_buf, { "", "Modified files:" })
        for _, f in ipairs(state.modified_files) do
          append_buf_lines(state.output_buf, { "  • " .. f })
        end
      end

    elseif event.type == "compaction_start" then
      append_buf_lines(state.output_buf, { "", "📦 Compacting context..." })

    elseif event.type == "compaction_end" then
      append_buf_lines(state.output_buf, { "📦 Compaction done" })

    elseif event.type == "auto_retry_start" then
      append_buf_lines(state.output_buf, {
        "",
        "🔄 Retrying (attempt " .. event.attempt .. "/" .. event.maxAttempts .. ")...",
      })

    elseif event.type == "auto_retry_end" then
      if event.success then
        append_buf_lines(state.output_buf, { "🔄 Retry succeeded" })
      else
        append_buf_lines(state.output_buf, { "❌ Retry failed: " .. (event.finalError or "") })
      end
    end
  end)
end

-- ─── Start / Stop ──────────────────────────────────────────────────────────────

start = function()
  if state.job_id then
    return
  end

  local stdout_remainder = ""

  state.job_id = vim.fn.jobstart({ "pi", "--mode", "rpc" }, {
    on_stdout = function(_, data)
      -- Neovim splits on newlines: ["partial"] or ["end_of_prev", "start_of_next", ...]
      -- The last element is always a partial (no trailing newline yet) unless it's "".
      for i, chunk in ipairs(data) do
        if i == 1 then
          -- First element continues the previous partial line
          stdout_remainder = stdout_remainder .. chunk
        else
          -- Each subsequent element means a newline was between previous and this
          local line = stdout_remainder
          if line:sub(-1) == "\r" then
            line = line:sub(1, -2)
          end
          if line ~= "" then
            local ok, event = pcall(vim.json.decode, line)
            if ok and event then
              handle_event(event)
            end
          end
          stdout_remainder = chunk
        end
      end
    end,
    on_stderr = function(_, data)
      local msg = table.concat(data, "")
      if msg ~= "" then
        notify("stderr: " .. msg, vim.log.levels.WARN)
      end
    end,
    on_exit = function(_, code)
      state.job_id = nil
      state.status = "idle"
      update_statusline()
      notify("exited with code " .. code)
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
  notify("started")
end

local function stop()
  if state.job_id then
    vim.fn.jobstop(state.job_id)
    state.job_id = nil
    state.status = "idle"
    update_statusline()
    notify("stopped")
  end
end

-- ─── Prompt Functions ──────────────────────────────────────────────────────────

local function prompt(message)
  if not message or message == "" then
    notify("Empty prompt", vim.log.levels.WARN)
    return
  end
  create_output_window()
  send_command({ type = "prompt", message = message })
end

-- Send prompt with current buffer as context
local function prompt_with_buffer(message)
  local buf_lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local buf_content = table.concat(buf_lines, "\n")
  local file = vim.fn.expand("%:p")
  local filetype = vim.bo.filetype

  local full_prompt = string.format(
    "I'm working on file: `%s` (filetype: %s)\n\nCurrent content:\n```%s\n%s\n```\n\n%s",
    file, filetype, filetype, buf_content, message
  )
  create_output_window()
  send_command({ type = "prompt", message = full_prompt })
end

-- Send prompt with visual selection as context
local function prompt_with_selection(message)
  local start_pos = vim.fn.getpos("'<")
  local end_pos = vim.fn.getpos("'>")
  local lines = vim.api.nvim_buf_get_lines(0, start_pos[2] - 1, end_pos[2], false)

  if #lines == 0 then
    notify("No selection", vim.log.levels.WARN)
    return
  end

  if #lines == 1 then
    lines[1] = lines[1]:sub(start_pos[3], end_pos[3])
  else
    lines[1] = lines[1]:sub(start_pos[3])
    lines[#lines] = lines[#lines]:sub(1, end_pos[3])
  end

  local selection = table.concat(lines, "\n")
  local file = vim.fn.expand("%:p")
  local filetype = vim.bo.filetype

  local full_prompt = string.format(
    "From file `%s` (lines %d-%d):\n```%s\n%s\n```\n\n%s",
    file, start_pos[2], end_pos[2], filetype, selection, message
  )
  create_output_window()
  send_command({ type = "prompt", message = full_prompt })
end

-- Interactive prompt input
local function prompt_input(with_context)
  ensure_running()
  vim.ui.input({ prompt = "pi> " }, function(input)
    if not input or input == "" then return end
    if with_context == "buffer" then
      prompt_with_buffer(input)
    elseif with_context == "selection" then
      prompt_with_selection(input)
    else
      prompt(input)
    end
  end)
end

-- ─── File Picker ───────────────────────────────────────────────────────────────

local function pick_modified_file()
  if #state.modified_files == 0 then
    notify("No files modified by pi", vim.log.levels.INFO)
    return
  end

  local seen = {}
  local unique = {}
  for _, f in ipairs(state.modified_files) do
    if not seen[f] then
      seen[f] = true
      table.insert(unique, f)
    end
  end

  vim.ui.select(unique, { prompt = "Open file modified by pi:" }, function(choice)
    if choice then
      vim.cmd("edit " .. vim.fn.fnameescape(choice))
    end
  end)
end

-- ─── Abort ─────────────────────────────────────────────────────────────────────

local function abort()
  send_command({ type = "abort" })
  notify("abort sent")
end

-- ─── Commands and Keymaps ──────────────────────────────────────────────────────

local function setup()
  -- Commands
  vim.api.nvim_create_user_command("PiStart", start, { desc = "Start pi agent" })
  vim.api.nvim_create_user_command("PiStop", stop, { desc = "Stop pi agent" })
  vim.api.nvim_create_user_command("PiAbort", abort, { desc = "Abort current pi operation" })
  vim.api.nvim_create_user_command("PiToggle", function()
    if state.job_id then stop() else start() end
  end, { desc = "Toggle pi agent" })

  vim.api.nvim_create_user_command("PiPrompt", function(opts)
    prompt(opts.args)
  end, { nargs = "+", desc = "Send prompt to pi" })

  vim.api.nvim_create_user_command("PiAsk", function()
    prompt_input(nil)
  end, { desc = "Interactive prompt to pi" })

  vim.api.nvim_create_user_command("PiAskBuffer", function()
    prompt_input("buffer")
  end, { desc = "Prompt pi with current buffer as context" })

  vim.api.nvim_create_user_command("PiAskSelection", function()
    prompt_input("selection")
  end, { desc = "Prompt pi with visual selection as context" })

  vim.api.nvim_create_user_command("PiOutput", create_output_window, { desc = "Show pi output window" })
  vim.api.nvim_create_user_command("PiClose", close_output, { desc = "Close pi output window" })
  vim.api.nvim_create_user_command("PiFiles", pick_modified_file, { desc = "Pick a file modified by pi" })

  vim.api.nvim_create_user_command("PiNewSession", function()
    send_command({ type = "new_session" })
    notify("new session started")
  end, { desc = "Start new pi session" })

  -- Keymaps (leader + Ctrl-p prefix)
  vim.keymap.set("n", "<leader><C-p>s", start, { desc = "Pi: Start" })
  vim.keymap.set("n", "<leader><C-p>q", stop, { desc = "Pi: Stop" })
  vim.keymap.set("n", "<leader><C-p>a", function() prompt_input(nil) end, { desc = "Pi: Ask" })
  vim.keymap.set("n", "<leader><C-p>b", function() prompt_input("buffer") end, { desc = "Pi: Ask with buffer" })
  vim.keymap.set("v", "<leader><C-p>a", function() prompt_input("selection") end, { desc = "Pi: Ask with selection" })
  vim.keymap.set("n", "<leader><C-p>x", abort, { desc = "Pi: Abort" })
  vim.keymap.set("n", "<leader><C-p>o", create_output_window, { desc = "Pi: Show output" })
  vim.keymap.set("n", "<leader><C-p>c", close_output, { desc = "Pi: Close output" })
  vim.keymap.set("n", "<leader><C-p>f", pick_modified_file, { desc = "Pi: Pick modified file" })
  vim.keymap.set("n", "<leader><C-p>n", function()
    send_command({ type = "new_session" })
    notify("new session started")
  end, { desc = "Pi: New session" })

  -- Auto-reload files modified externally
  vim.opt.autoread = true
  vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter" }, {
    pattern = "*",
    command = "checktime",
  })

  -- Expose status for statusline
  vim.g.pi_status = "💤 pi: idle"
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
M.state = state

return M
