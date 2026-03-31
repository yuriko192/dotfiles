-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information

local result = {
  {
    'mbbill/undotree',
  },
  {
    'folke/persistence.nvim',
    event = 'BufReadPre', -- this will only start session saving when an actual file was opened
    opts = {
      -- add any custom options here
    },
    keys = {
      {
        '<leader>ls',
        function()
          require('persistence').load()
        end,
        desc = 'Restore Session',
      },
      {
        '<leader>lS',
        function()
          require('persistence').select()
        end,
        desc = 'Select Session',
      },
      {
        '<leader>ll',
        function()
          require('persistence').load { last = true }
        end,
        desc = 'Restore Last Session',
      },
      {
        '<leader>lfq',
        function()
          require('persistence').stop()
        end,
        desc = "Don't Save Current Session",
      },
    },
  },
}

if vim.g.vscode then
  return result
end

function tableConcat(t1, t2)
  for i = 1, #t2 do
    t1[#t1 + 1] = t2[i]
  end
  return t1
end

local resultWithoutVscode = {
  -- {
  --   'nvim-tree/nvim-tree.lua',
  --   version = '*',
  --   lazy = false,
  --   dependencies = {
  --     'nvim-tree/nvim-web-devicons',
  --   },
  --   config = function()
  --     require('nvim-tree').setup {
  --       on_attach = function(bufnr)
  --         local api = require 'nvim-tree.api'
  --
  --         api.config.mappings.default_on_attach(bufnr)
  --
  --         vim.keymap.set('n', '<C-e>', '<cmd>NvimTreeToggle<CR>', { desc = 'nvimtree toggle window' })
  --         vim.keymap.set('n', '<leader>e', '<cmd>NvimTreeFocus<CR>', { desc = 'nvimtree focus window' })
  --
  --         vim.keymap.set('n', '<leader>FF', '<cmd>NvimTreeFindFile<CR>', { desc = 'nvimtree focus window' })
  --       end,
  --     }
  --   end,
  -- },
  {
    'stevearc/oil.nvim',
    opts = {},
    dependencies = { { 'nvim-mini/mini.icons', opts = {} } },
    config = function()
      require('oil').setup {
        default_file_explorer = true,
        view_options = {
          show_hidden = true,
        },
      }
    end,
    lazy = false,
  },
  {
    'christoomey/vim-tmux-navigator',
    cmd = {
      'TmuxNavigateLeft',
      'TmuxNavigateDown',
      'TmuxNavigateUp',
      'TmuxNavigateRight',
      'TmuxNavigatePrevious',
      'TmuxNavigatorProcessList',
    },
    keys = {
      { '<c-h>', '<cmd><C-U>TmuxNavigateLeft<cr>' },
      { '<c-j>', '<cmd><C-U>TmuxNavigateDown<cr>' },
      { '<c-k>', '<cmd><C-U>TmuxNavigateUp<cr>' },
      { '<c-l>', '<cmd><C-U>TmuxNavigateRight<cr>' },
      { '<c-\\>', '<cmd><C-U>TmuxNavigatePrevious<cr>' },
    },
  },
  {
    'ray-x/go.nvim',
    dependencies = { -- optional packages
      'ray-x/guihua.lua',
      'neovim/nvim-lspconfig',
      'nvim-treesitter/nvim-treesitter',
    },
    opts = {
      settings = {
        gopls = {
          completeUnimported = true,
          usePlaceholders = true,
          staticcheck = true,
          gofumpt = true,
          analyses = {
            unusedparams = true,
          },
        },
      },
      capabilities = require('blink.cmp').get_lsp_capabilities(),
    },
    config = function(lp, opts)
      require('go').setup(opts)
      local format_sync_grp = vim.api.nvim_create_augroup('GoFormat', {})
      vim.api.nvim_create_autocmd('BufWritePre', {
        pattern = '*.go',
        callback = function()
          require('go.format').goimports()
        end,
        group = format_sync_grp,
      })
    end,
    event = { 'CmdlineEnter' },
    ft = { 'go', 'gomod', 'gosum', 'gotmpl', 'gohtmltmpl', 'gotexttmpl', 'templ' },
    build = ':lua require("go.install").update_all_sync()', -- if you need to install/update all binaries
  },
  {
    'tpope/vim-fugitive',
  },
  {
    'olrtg/nvim-emmet',
    config = function()
      vim.keymap.set({ 'n', 'v' }, '<leader>ne', require('nvim-emmet').wrap_with_abbreviation, { desc = 'Emmet - Wrap Abbreviation' })
    end,
  },
  {
    'VonHeikemen/fine-cmdline.nvim',
    dependencies = {
      { 'MunifTanjim/nui.nvim' },
    },
  },
  { 'akinsho/bufferline.nvim', version = '*', dependencies = 'nvim-tree/nvim-web-devicons' },
  {
    'kevalin/mermaid.nvim',
    dependencies = { 'nvim-treesitter/nvim-treesitter' },
    config = function()
      require('mermaid').setup()

      -- Install the tree-sitter parser manually if TSInstall fails
      -- :TSInstall mermaid
    end,
  },
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

result = tableConcat(result, resultWithoutVscode)
return result
