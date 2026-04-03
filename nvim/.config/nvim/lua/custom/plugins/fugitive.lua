if vim.g.vscode then
  return {}
end

return {
  {
    'tpope/vim-fugitive',
    config = function()
      vim.keymap.set('n', '<leader>gs', vim.cmd.Git, { desc = 'Toggle Git fugitive' })
      vim.keymap.set('n', '<leader>gl', ':Git log<CR>', { desc = 'Toggle Git logs' })
      vim.keymap.set('n', '<leader>gb', ':Git blame<CR>', { desc = 'Toggle Git blame' })
    end,
  },
}
