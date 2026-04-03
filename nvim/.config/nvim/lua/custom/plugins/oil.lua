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
    end,
    lazy = false,
  },
}
