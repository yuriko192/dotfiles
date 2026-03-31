-- vim.env.GOPATH = vim.fn.expand '$HOME/go'
-- vim.env.GOROOT = '/usr/local/go_arm_1.24'

-- vim.keymap.set('n', '<leader><F1>', function()
--   print 'SET TO ARM'
--   vim.env.GOROOT = '/usr/local/go'
--   print 'SET TO ARM'
-- end, { desc = 'Set GOROOT to arm' })
--
-- vim.keymap.set('n', '<leader><F2>', function()
--   print 'SET TO AMD'
--   vim.env.GOROOT = '/usr/local/go_amd_1.24'
--   print 'SET TO AMD'
-- end, { desc = 'Set GOROOT to amd' })
--
-- vim.keymap.set('n', '<leader><F3>', function()
--   local temp = vim.env.GOROOT
--   print(string.format('temp = %s', temp))
-- end, { desc = 'DEBUG COMMAND' })

return {}
