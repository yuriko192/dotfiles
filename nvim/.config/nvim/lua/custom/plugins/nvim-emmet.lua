if vim.g.vscode then
  return {}
end

return {
  {
    'olrtg/nvim-emmet',
    config = function()
      vim.keymap.set({ 'n', 'v' }, '<leader>ne', require('nvim-emmet').wrap_with_abbreviation, { desc = 'Emmet - Wrap Abbreviation' })
    end,
  },
}
