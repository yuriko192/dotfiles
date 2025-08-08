vim.keymap.set('n', '<leader>xe', ':%bd|e#<CR>', { desc = 'Close other buffers' })
vim.keymap.set('n', '<leader>xx', ':bd<CR>', { desc = 'Close current buffer' })
vim.keymap.set('n', '<leader>xa', ':%bd<CR>', { desc = 'Close all buffers' })

vim.keymap.set('v', 'J', ":m '>+1<CR>gv=gv", { desc = 'Move selection down' })
vim.keymap.set('v', 'K', ":m '<-2<CR>gv=gv", { desc = 'Move selection up' })

vim.keymap.set('x', '<leader>p', [["_dP]], { desc = 'paste w/o buffer overwrite' })
vim.keymap.set({ 'n', 'v' }, '<leader>y', [["+y]], { desc = 'yank to global clipboard' })
vim.keymap.set('n', '<leader>Y', [["+Y]], { desc = 'yank till EoLine to global clipboard' })
vim.keymap.set({ 'n', 'v' }, '<leader>d', '"_d', { desc = 'delete w/o buffer overwrite' })

vim.keymap.set('n', '<leader>s', [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]], { desc = 'Rename all occurence of highlight in buffer' })

vim.keymap.set('n', '<leader>u', vim.cmd.UndotreeToggle, { desc = 'Toggle undotree' })

vim.keymap.set('n', '<leader>gs', vim.cmd.Git, { desc = 'Toggle Git fugitive' })
vim.keymap.set('n', '<leader>gl', ':Git log<CR>', { desc = 'Toggle Git logs' })
vim.keymap.set('n', '<leader>gb', ':Git blame<CR>', { desc = 'Toggle Git blame' })

vim.api.nvim_set_keymap('n', ':', '<cmd>FineCmdline<CR>', { noremap = true })

vim.keymap.set('n', '<leader><C-f>', require('nvim-tree.api').tree.find_file, { desc = 'Highlight current file' })

return {}
