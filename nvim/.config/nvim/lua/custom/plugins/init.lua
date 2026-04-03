-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information

local result = {}

return result

-- if vim.g.vscode then
--   return result
-- end
--
-- function tableConcat(t1, t2)
--   for i = 1, #t2 do
--     t1[#t1 + 1] = t2[i]
--   end
--   return t1
-- end
--
-- local resultWithoutVscode = {
--   -- {
--   --   'nvim-tree/nvim-tree.lua',
--   --   version = '*',
--   --   lazy = false,
--   --   dependencies = {
--   --     'nvim-tree/nvim-web-devicons',
--   --   },
--   --   config = function()
--   --     require('nvim-tree').setup {
--   --       on_attach = function(bufnr)
--   --         local api = require 'nvim-tree.api'
--   --
--   --         api.config.mappings.default_on_attach(bufnr)
--   --
--   --         vim.keymap.set('n', '<C-e>', '<cmd>NvimTreeToggle<CR>', { desc = 'nvimtree toggle window' })
--   --         vim.keymap.set('n', '<leader>e', '<cmd>NvimTreeFocus<CR>', { desc = 'nvimtree focus window' })
--   --
--   --         vim.keymap.set('n', '<leader>FF', '<cmd>NvimTreeFindFile<CR>', { desc = 'nvimtree focus window' })
--   --       end,
--   --     }
--   --   end,
--   -- },
-- }
--
-- result = tableConcat(result, resultWithoutVscode)
-- return result
