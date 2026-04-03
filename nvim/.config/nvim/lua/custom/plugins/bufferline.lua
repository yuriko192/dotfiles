if vim.g.vscode then
  return {}
end

return {
  { 'akinsho/bufferline.nvim', version = '*', dependencies = 'nvim-tree/nvim-web-devicons' },
}
