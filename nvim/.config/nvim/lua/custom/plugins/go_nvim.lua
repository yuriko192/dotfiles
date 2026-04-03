if vim.g.vscode then
  return {}
end

return {
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
}
