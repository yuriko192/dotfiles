if vim.g.vscode then
  return {}
end

return {
  {
    'nvimdev/dashboard-nvim',
    event = 'VimEnter',
    config = function()
      require('dashboard').setup {
        config = {
          shortcut = {},
          packages = { enable = true }, -- show how many plugins neovim loaded
          footer = {}, -- footer
        },
      }
    end,
    dependencies = { { 'nvim-tree/nvim-web-devicons' } },
  },
}
