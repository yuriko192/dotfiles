if vim.g.vscode then
  return {}
end

return {
  {
    'VonHeikemen/fine-cmdline.nvim',
    dependencies = {
      { 'MunifTanjim/nui.nvim' },
    },
  },
}
