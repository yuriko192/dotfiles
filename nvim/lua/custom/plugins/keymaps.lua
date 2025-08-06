vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle, { desc = "Toggle undotree" })

vim.keymap.set("n", "<leader>gs", vim.cmd.Git, { desc = "Toggle Git fugitive" })
vim.keymap.set("n", "<leader>gl", ":Git log<CR>", { desc = "Toggle Git logs" })
vim.keymap.set("n", "<leader>gb", ":Git blame<CR>", { desc = "Toggle Git blame" })

vim.api.nvim_set_keymap("n", ":", "<cmd>FineCmdline<CR>", { noremap = true })

return {}
