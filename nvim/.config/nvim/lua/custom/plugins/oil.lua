if vim.g.vscode then
  return {}
end

return {
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

      vim.keymap.set('n', '-', '<CMD>Oil<CR>', { desc = 'Highlight current file' })
    end,
    lazy = false,
  },
}
