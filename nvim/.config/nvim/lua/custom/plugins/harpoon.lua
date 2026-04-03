if vim.g.vscode then
  return {}
end

return {
  {
    'ThePrimeagen/harpoon',
    branch = 'harpoon2',
    dependencies = { 'nvim-lua/plenary.nvim' },
    config = function()
      local harpoon = require 'harpoon'
      harpoon:setup()

      -- basic telescope configuration
      local conf = require('telescope.config').values
      local function toggle_telescope(harpoon_files)
        local telescopePickers = require 'telescope.pickers'

        local finder = function()
          local paths = {}
          for _, item in ipairs(harpoon_files.items) do
            table.insert(paths, item.value)
          end

          return require('telescope.finders').new_table {
            results = paths,
          }
        end

        local function remove_entry(prompt_bufnr)
          local state = require 'telescope.actions.state'
          local selected_entry = state.get_selected_entry()
          local current_picker = state.get_current_picker(prompt_bufnr)

          table.remove(harpoon_files.items, selected_entry.index)
          current_picker:refresh(finder())
        end

        -- local function move_entry_down(prompt_bufnr)
        --   local state = require 'telescope.actions.state'
        --   local selected_entry = state.get_selected_entry()
        --   local current_picker = state.get_current_picker(prompt_bufnr)
        --   if selected_entry.index == 1 then
        --     return
        --   end
        --
        --   table.remove(harpoon_files.items, selected_entry.index)
        --   table.insert(harpoon_files.items, selected_entry.index - 1, selected_entry.value)
        --   current_picker:refresh(finder())
        -- end
        --
        -- local function move_entry_up(prompt_bufnr)
        --   local state = require 'telescope.actions.state'
        --   local selected_entry = state.get_selected_entry()
        --   local current_picker = state.get_current_picker(prompt_bufnr)
        --   if selected_entry.index == harpoon:list():length() then
        --     return
        --   end
        --
        --   table.remove(harpoon_files.items, selected_entry.index)
        --   table.insert(harpoon_files.items, selected_entry.index + 1, selected_entry.value)
        --   current_picker:refresh(finder())
        -- end

        telescopePickers
          .new({}, {
            prompt_title = 'Telescope [Harpoon]',
            finder = finder(),
            previewer = conf.file_previewer {},
            sorter = conf.generic_sorter {},
            attach_mappings = function(prompt_bufnr, map)
              map('i', '<c-d>', function()
                remove_entry(prompt_bufnr)
              end)
              map('n', '<c-d>', function()
                remove_entry(prompt_bufnr)
              end)

              -- map('i', '<c-s-n>', function()
              --   move_entry_down(prompt_bufnr)
              -- end)
              -- map('n', '<c-s-n>', function()
              --   move_entry_down(prompt_bufnr)
              -- end)
              --
              -- map('i', '<c-s-p>', function()
              --   move_entry_up(prompt_bufnr)
              -- end)
              -- map('n', '<c-s-p>', function()
              --   move_entry_up(prompt_bufnr)
              -- end)
              return true
            end,
          })
          :find()
      end

      vim.keymap.set('n', '<leader>aa', function()
        harpoon:list():add()
      end, { desc = 'H[A]rpoon - [A]dd file' })
      vim.keymap.set('n', '<leader>al', function()
        toggle_telescope(harpoon:list())
      end, { desc = 'H[A]rpoon - [L]ist file' })

      vim.keymap.set('n', '<leader>a1', function()
        harpoon:list():select(1)
      end, { desc = 'H[A]rpoon - Jump to File [1]' })
      vim.keymap.set('n', '<leader>a2', function()
        harpoon:list():select(2)
      end, { desc = 'H[A]rpoon - Jump to File [2]' })
      vim.keymap.set('n', '<leader>a3', function()
        harpoon:list():select(3)
      end, { desc = 'H[A]rpoon - Jump to File [3]' })
      vim.keymap.set('n', '<leader>a4', function()
        harpoon:list():select(4)
      end, { desc = 'H[A]rpoon - Jump to File [4]' })

      -- Toggle previous & next buffers stored within Harpoon list
      vim.keymap.set('n', '<C-S-P>', function()
        harpoon:list():prev()
      end, { desc = 'Harpoon - Jump to [P]revious' })
      vim.keymap.set('n', '<C-S-N>', function()
        harpoon:list():next()
      end, { desc = 'Harpoon - Jump to [N]ext' })
    end,
  },
}
