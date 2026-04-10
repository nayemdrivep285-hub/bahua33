require("dotenv").config()
const fs = require("fs").promises
const fsSync = require("fs")
const { Telegraf, Markup } = require("telegraf")
const mongoose = require("mongoose")

// ================= MONGODB =================
const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI missing")
  process.exit(1)
}
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => { console.error(err); process.exit(1) })

// ================= USER SCHEMA =================
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  phone: String,
  isPlayer: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
})
const User = mongoose.model('User', userSchema)

// ================= BOT INIT =================
const bot = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map(id => parseInt(id.trim()))
  : []

// ================= JSON STORAGE (TICKETS) =================
const TICKETS_FILE = "./tickets.json"
let pendingTickets = []
try { pendingTickets = JSON.parse(fsSync.readFileSync(TICKETS_FILE, "utf8")) } catch(e) {}
function saveTickets() { fsSync.writeFileSync(TICKETS_FILE, JSON.stringify(pendingTickets, null, 2)) }

// ================= SESSIONS =================
const sessions = {}
const userLastAdmin = {}
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      state: null,
      data: {},
      processing: false,
      submitting: false,
      calendar: { year: new Date().getFullYear(), month: new Date().getMonth() }
    }
  }
  return sessions[userId]
}
function clearSession(userId) { delete sessions[userId] }

// ================= USER HELPERS =================
async function updateUser(userId, updates) {
  await User.findOneAndUpdate({ userId }, { $set: updates, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
}
async function getPhone(userId) {
  const u = await User.findOne({ userId })
  return u ? u.phone : null
}
async function setPhone(userId, phone) {
  await User.findOneAndUpdate({ userId }, { phone }, { upsert: true })
}
async function getAllUserIds() {
  const users = await User.find({}, 'userId')
  return users.map(u => u.userId)
}
async function getPlayers() {
  return await User.find({ isPlayer: true }, 'userId username phone').limit(10)
}

async function ensurePhone(ctx) {
  if (ADMIN_IDS.includes(ctx.from.id)) return true
  const phone = await getPhone(ctx.from.id)
  if (phone) return true
  await ctx.reply(
    "Please share your phone number to continue:",
    Markup.keyboard([[Markup.button.contactRequest("📱 Share Contact")]]).resize().oneTime()
  )
  return false
}

function displayUser(ctx) {
  return ctx.from.username ? `@${ctx.from.username}` : `ID: ${ctx.from.id}`
}
function safe(val) {
  return val !== undefined && val !== null && val !== "" ? val : "Not provided"
}
function generateTrackId() {
  return `TKT-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`
}

// ================= MENUS =================
function userMenu() {
  return Markup.keyboard([["📞 Player Support"]]).resize()
}
function adminMenu() {
  return Markup.keyboard([
    ["📥 Deposit Problems", "📤 Withdrawal Problems"],
    ["📢 Broadcast", "👥 Users"],
    ["🔙 Main Menu"]
  ]).resize()
}

// ================= START =================
bot.start(async (ctx) => {
  const userId = ctx.from.id
  if (ADMIN_IDS.includes(userId)) {
    return ctx.reply("Welcome Admin!", adminMenu())
  }
  const phone = await getPhone(userId)
  if (phone) {
    await updateUser(userId, {
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name
    })
    return ctx.reply("Welcome back! Choose an option:", userMenu())
  }
  await ctx.reply(
    "Please share your phone number:",
    Markup.keyboard([[Markup.button.contactRequest("📱 Share Contact")]]).resize().oneTime()
  )
})

// ================= CONTACT HANDLER =================
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id
  const phone = ctx.message.contact.phone_number
  await setPhone(userId, phone)
  await updateUser(userId, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    lastName: ctx.from.last_name
  })
  if (ADMIN_IDS.includes(userId)) {
    ctx.reply("Thank you! Admin menu:", adminMenu())
  } else {
    ctx.reply("Thank you! You can now use the bot.", userMenu())
  }
})

// ================= MAIN MENU =================
bot.hears("🔙 Main Menu", async (ctx) => {
  if (ADMIN_IDS.includes(ctx.from.id)) {
    return ctx.reply("Admin menu:", adminMenu())
  }
  if (!(await ensurePhone(ctx))) return
  ctx.reply("Main menu:", userMenu())
})

// ================= PLAYER SUPPORT =================
bot.hears("📞 Player Support", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const userId = ctx.from.id
  clearSession(userId)
  const session = getSession(userId)
  session.state = "player_country_selection"
  session.data.type = "player"
  await ctx.reply(
    "👤 Player Support\n\nWhere are you from?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🇧🇩 Bangladesh", "player_select_bangladesh")],
      [Markup.button.callback("🇮🇳 India", "player_select_india")],
      [Markup.button.callback("« Back", "main_menu")]
    ])
  )
})

// ================= COUNTRY SELECTION =================
bot.action(/player_select_(.+)/, async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const country = ctx.match[1]
  const session = getSession(ctx.from.id)
  session.data.country = country
  session.state = "player_issue_selection"
  await ctx.editMessageText(
    `🌍 Player Support - ${country}\n\nWhat issue type?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Deposit", "player_issue_deposit")],
      [Markup.button.callback("Withdrawal", "player_issue_withdrawal")],
      [Markup.button.callback("← Back", "main_menu")]
    ])
  )
  await ctx.answerCbQuery()
})

// ================= ISSUE TYPE =================
bot.action("player_issue_deposit", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const session = getSession(ctx.from.id)
  session.data.issueType = "Deposit"
  session.data.category = "deposit"
  await showPaymentSystems(ctx, session)
})
bot.action("player_issue_withdrawal", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const session = getSession(ctx.from.id)
  session.data.issueType = "Withdrawal"
  session.data.category = "withdrawal"
  await showPaymentSystems(ctx, session)
})

async function showPaymentSystems(ctx, session) {
  const country = session.data.country
  if (country === "bangladesh") {
    await ctx.editMessageText(
      "🇧🇩 Bangladesh Payment Systems",
      Markup.inlineKeyboard([
        [Markup.button.callback("bKash", "pay_bkash"), Markup.button.callback("Nagad", "pay_nagad")],
        [Markup.button.callback("Rocket", "pay_rocket"), Markup.button.callback("Upay", "pay_upay")],
        [Markup.button.callback("MoneyGo", "pay_moneygo"), Markup.button.callback("Binance", "pay_binance")],
        [Markup.button.callback("Main Menu", "main_menu")]
      ])
    )
  } else if (country === "india") {
    await ctx.editMessageText(
      "🇮🇳 India Payment Systems",
      Markup.inlineKeyboard([
        [Markup.button.callback("PhonePe", "pay_phonepe"), Markup.button.callback("PayTM UPI", "pay_paytm")],
        [Markup.button.callback("Main Menu", "main_menu")]
      ])
    )
  }
}

// ================= PAYMENT SELECTED =================
bot.action(/pay_(.+)/, async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const payment = ctx.match[1]
  const session = getSession(ctx.from.id)
  session.data.paymentSystem = payment

  if (payment === 'binance') {
    session.state = 'waiting_binance_player_id'
    await ctx.reply("Enter Player ID:")
  } else if (payment === 'moneygo') {
    session.state = 'waiting_moneygo_player_id'
    await ctx.reply("Enter Player ID:")
  } else {
    session.state = "waiting_game_user_id"
    await ctx.reply("Enter User ID (numbers only):")
  }
  await ctx.answerCbQuery()
})

// ================= TEXT FLOW =================
bot.on("text", async (ctx) => {
  const session = getSession(ctx.from.id)
  const userId = ctx.from.id
  const text = ctx.message.text

  const isAdminMenuCmd = (t) => ADMIN_IDS.includes(userId) && ["Deposit Problems","Withdrawal Problems","Broadcast","Users","🔙 Main Menu"].some(cmd => t.includes(cmd))

  if (ADMIN_IDS.includes(userId) && session.state !== null && isAdminMenuCmd(text)) {
    console.log(`Clearing admin state (${session.state}) due to menu command.`)
    clearSession(userId)
  }

  // ADMIN BROADCAST
  if (ADMIN_IDS.includes(userId) && session.state === "admin_broadcast_message") {
    const category = session.broadcastCategory
    let targetUserIds = []
    if (category === 'all') {
      targetUserIds = await getAllUserIds()
    } else {
      const users = await User.find({ isPlayer: true }, 'userId')
      targetUserIds = users.map(u => u.userId)
    }
    ctx.reply(`Broadcasting to ${targetUserIds.length} users...`)
    let success = 0, fail = 0
    for (const uid of targetUserIds) {
      try {
        await bot.telegram.sendMessage(uid, `📢 Broadcast:\n\n${text}`)
        success++
      } catch(e) { fail++ }
      await new Promise(r => setTimeout(r, 100))
    }
    ctx.reply(`✅ Done. Sent: ${success}, Failed: ${fail}`)
    clearSession(userId)
    return
  }

  // ADMIN REPLY
  if (ADMIN_IDS.includes(userId) && session.state === "admin_reply") {
    const targetUserId = session.data.targetUserId
    if (!targetUserId) {
      ctx.reply("❌ No user to reply to.")
      clearSession(userId)
      return
    }
    try {
      await bot.telegram.sendMessage(targetUserId, `✉️ Admin reply:\n\n${text}`)
      ctx.reply("✅ Reply sent.")
      userLastAdmin[targetUserId] = userId
    } catch(e) {
      ctx.reply("❌ Failed to send.")
    }
    clearSession(userId)
    return
  }

  // BINANCE FLOW
  if (session.state === "waiting_binance_player_id") {
    session.data.gameUserId = text
    session.state = "waiting_binance_uid"
    ctx.reply("Enter Binance UID / TXID:")
    return
  }
  if (session.state === "waiting_binance_uid") {
    session.data.binanceUid = text
    session.state = "waiting_binance_amount"
    ctx.reply("Enter Amount:")
    return
  }
  if (session.state === "waiting_binance_amount") {
    session.data.amount = text
    session.state = "waiting_binance_date"
    showCalendar(ctx, session)
    return
  }

  // MONEYGO FLOW
  if (session.state === "waiting_moneygo_player_id") {
    session.data.gameUserId = text
    session.state = "waiting_moneygo_number"
    ctx.reply("Enter MoneyGo Number:")
    return
  }
  if (session.state === "waiting_moneygo_number") {
    session.data.moneygoNumber = text
    session.state = "waiting_moneygo_amount"
    ctx.reply("Enter Amount:")
    return
  }
  if (session.state === "waiting_moneygo_amount") {
    session.data.amount = text
    session.state = "waiting_moneygo_date"
    showCalendar(ctx, session)
    return
  }

  // SUPPORT FLOW
  if (session.state === "waiting_game_user_id") {
    session.data.gameUserId = text
    session.state = "waiting_phone_number"
    ctx.reply("Enter Phone Number (format: +880XXXXXXXXXXX):")
    return
  }
  if (session.state === "waiting_phone_number") {
    session.data.phoneNumber = text
    session.state = "waiting_agent_number"
    ctx.reply("Enter Agent Number:")
    return
  }
  if (session.state === "waiting_agent_number") {
    session.data.agentNumber = text
    session.state = "waiting_date"
    showCalendar(ctx, session)
    return
  }
  if (session.state === "waiting_time") {
    session.data.selectedTime = text
    session.state = "waiting_amount"
    ctx.reply("Enter Amount:")
    return
  }
  if (session.state === "waiting_amount") {
    session.data.amount = text
    session.state = "waiting_trx_id"
    ctx.reply("Enter Transaction ID (Trx ID):")
    return
  }
  if (session.state === "waiting_trx_id") {
    session.data.trxId = text
    session.state = "waiting_file"
    ctx.reply("Please upload a screenshot or video file.")
    return
  }

  // ADMIN MENU COMMANDS
  if (ADMIN_IDS.includes(userId) && session.state === null) {
    if (text.includes("Deposit Problems")) {
      showTicketList(ctx, "deposit", 0)
    } else if (text.includes("Withdrawal Problems")) {
      showTicketList(ctx, "withdrawal", 0)
    } else if (text.includes("Broadcast")) {
      const s = getSession(userId)
      s.state = "admin_broadcast_category"
      await ctx.reply(
        "Select broadcast target:",
        Markup.inlineKeyboard([
          [Markup.button.callback("All Users", "broadcast_all")],
          [Markup.button.callback("Players", "broadcast_players")],
          [Markup.button.callback("Cancel", "main_menu")]
        ])
      )
    } else if (text.includes("Users")) {
      const players = await getPlayers()
      let msg = "<b>👥 Recent Players</b>\n\n"
      players.forEach((u, i) => {
        const name = u.username ? `@${u.username}` : (u.phone ? `📞 ${u.phone}` : `ID: ${u.userId}`)
        msg += `${i+1}. ${name}\n`
      })
      ctx.reply(msg, { parse_mode: "HTML" })
    }
    return
  }

  // USER REPLY TO ADMIN
  if (!ADMIN_IDS.includes(userId) && !session.state) {
    const adminId = userLastAdmin[userId]
    if (adminId) {
      await bot.telegram.sendMessage(
        adminId,
        `✉️ Reply from user ${displayUser(ctx)}:\n\n${text}`,
        Markup.inlineKeyboard([[Markup.button.callback("💬 Reply", `reply_${userId}`)]])
      )
      ctx.reply("✅ Your reply has been sent.")
    } else {
      ctx.reply("You don't have an ongoing conversation. Please start a new support ticket.")
    }
    return
  }
})

// ================= CALENDAR =================
function showCalendar(ctx, session) {
  let year = session.calendar.year
  let month = session.calendar.month
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"]
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  let buttons = []
  let row = []
  for (let i = 0; i < firstDay; i++) row.push(Markup.button.callback(" ", "ignore"))
  for (let d = 1; d <= daysInMonth; d++) {
    row.push(Markup.button.callback(d.toString(), `date_${d}`))
    if (row.length === 7) { buttons.push(row); row = [] }
  }
  if (row.length) { while (row.length < 7) row.push(Markup.button.callback(" ", "ignore")); buttons.push(row) }
  buttons.push([
    Markup.button.callback("◀ Prev", "prev_month"),
    Markup.button.callback(`${monthNames[month]} ${year}`, "ignore"),
    Markup.button.callback("Next ▶", "next_month")
  ])
  buttons.push([Markup.button.callback("Main Menu", "main_menu")])
  ctx.reply(`📅 Select Date\n${monthNames[month]} ${year}`, Markup.inlineKeyboard(buttons))
}

bot.action(/date_(\d+)/, async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const day = ctx.match[1]
  const session = getSession(ctx.from.id)
  const year = session.calendar.year
  const month = session.calendar.month
  const selectedDate = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
  session.data.selectedDate = selectedDate
  if (session.state === "waiting_binance_date") {
    session.state = "waiting_binance_file"
    await ctx.editMessageText(`Selected: ${selectedDate}\n\nUpload screenshot/video.`)
  } else if (session.state === "waiting_moneygo_date") {
    session.state = "waiting_moneygo_file"
    await ctx.editMessageText(`Selected: ${selectedDate}\n\nUpload screenshot/video.`)
  } else {
    session.state = "waiting_time"
    await ctx.editMessageText(`Selected: ${selectedDate}\n\nEnter time (any format):`)
  }
  await ctx.answerCbQuery()
})

bot.action("prev_month", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const session = getSession(ctx.from.id)
  let { year, month } = session.calendar
  if (month === 0) { month = 11; year-- } else { month-- }
  session.calendar = { year, month }
  showCalendar(ctx, session)
  await ctx.answerCbQuery()
})
bot.action("next_month", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const session = getSession(ctx.from.id)
  let { year, month } = session.calendar
  if (month === 11) { month = 0; year++ } else { month++ }
  session.calendar = { year, month }
  showCalendar(ctx, session)
  await ctx.answerCbQuery()
})
bot.action("ignore", async (ctx) => { await ctx.answerCbQuery() })

// ================= FILE UPLOAD =================
bot.on(["photo", "video"], async (ctx) => {
  const session = getSession(ctx.from.id)
  const userId = ctx.from.id

  if (ADMIN_IDS.includes(userId) && session.state === "admin_broadcast_message") {
    const category = session.broadcastCategory
    const caption = ctx.message.caption || ""
    let targetUserIds = []
    if (category === 'all') {
      targetUserIds = await getAllUserIds()
    } else {
      const users = await User.find({ isPlayer: true }, 'userId')
      targetUserIds = users.map(u => u.userId)
    }
    ctx.reply(`Broadcasting file to ${targetUserIds.length} users...`)
    const fileId = ctx.message.photo ? ctx.message.photo.pop().file_id : ctx.message.video.file_id
    const fileType = ctx.message.photo ? 'photo' : 'video'
    let success = 0, fail = 0
    for (const uid of targetUserIds) {
      try {
        if (fileType === 'photo') await bot.telegram.sendPhoto(uid, fileId, { caption })
        else await bot.telegram.sendVideo(uid, fileId, { caption })
        success++
      } catch(e) { fail++ }
      await new Promise(r => setTimeout(r, 100))
    }
    ctx.reply(`✅ Done. Sent: ${success}, Failed: ${fail}`)
    clearSession(userId)
    return
  }

  if (!ADMIN_IDS.includes(userId) && session.state === "waiting_file") {
    if (ctx.message.photo) {
      session.data.fileId = ctx.message.photo.pop().file_id
      session.data.fileType = "photo"
      session.data.fileName = "screenshot.jpg"
    } else if (ctx.message.video) {
      session.data.fileId = ctx.message.video.file_id
      session.data.fileType = "video"
      session.data.fileName = "video.mp4"
    }
    ctx.reply("File uploaded. Please confirm your details.")
    await showConfirmation(ctx, session)
  } else if (!ADMIN_IDS.includes(userId) && session.state === "waiting_binance_file") {
    if (ctx.message.photo) session.data.fileId = ctx.message.photo.pop().file_id
    else session.data.fileId = ctx.message.video.file_id
    session.data.fileType = ctx.message.photo ? "photo" : "video"
    session.data.fileName = ctx.message.photo ? "screenshot.jpg" : "video.mp4"
    ctx.reply("File uploaded. Please confirm.")
    await showConfirmation(ctx, session)
  } else if (!ADMIN_IDS.includes(userId) && session.state === "waiting_moneygo_file") {
    if (ctx.message.photo) session.data.fileId = ctx.message.photo.pop().file_id
    else session.data.fileId = ctx.message.video.file_id
    session.data.fileType = ctx.message.photo ? "photo" : "video"
    session.data.fileName = ctx.message.photo ? "screenshot.jpg" : "video.mp4"
    ctx.reply("File uploaded. Please confirm.")
    await showConfirmation(ctx, session)
  }
})

// ================= CONFIRMATION & SUBMIT =================
async function showConfirmation(ctx, session) {
  session.state = "confirm"
  let summary = `📋 Confirm Details

Country: ${safe(session.data.country)}
Issue: ${safe(session.data.issueType)}
Payment: ${safe(session.data.paymentSystem)}
Game User ID: ${safe(session.data.gameUserId)}`

  if (session.data.paymentSystem === 'binance') {
    summary += `\nBinance UID: ${safe(session.data.binanceUid)}`
  } else if (session.data.paymentSystem === 'moneygo') {
    summary += `\nMoneyGo Number: ${safe(session.data.moneygoNumber)}`
  } else {
    summary += `\nPhone: ${safe(session.data.phoneNumber)}`
    summary += `\nAgent Number: ${safe(session.data.agentNumber)}`
    summary += `\nTrx ID: ${safe(session.data.trxId)}`
  }
  summary += `\nAmount: ${safe(session.data.amount)}`
  summary += `\nDate: ${safe(session.data.selectedDate)}`
  if (session.data.selectedTime) summary += `\nTime: ${safe(session.data.selectedTime)}`
  summary += `\nFile: ${safe(session.data.fileName)}`

  if (session.data.fileType === "photo") {
    await ctx.replyWithPhoto(session.data.fileId, { caption: summary })
  } else {
    await ctx.replyWithVideo(session.data.fileId, { caption: summary })
  }
  await ctx.reply(
    "Is this correct?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Submit", "submit_player")],
      [Markup.button.callback("❌ Restart", "restart_player")],
      [Markup.button.callback("Main Menu", "main_menu")]
    ])
  )
}

bot.action("submit_player", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const session = getSession(ctx.from.id)
  if (session.submitting) return
  session.submitting = true

  const trackId = generateTrackId()
  const userId = ctx.from.id
  const username = ctx.from.username

  const ticket = {
    trackId, userId, username,
    category: session.data.category,
    data: { ...session.data },
    status: "open",
    timestamp: Date.now()
  }
  pendingTickets.push(ticket)
  saveTickets()
  await updateUser(userId, { isPlayer: true })

  let message = `🎫 New Ticket\nTrack ID: ${trackId}\nUser: ${ctx.from.first_name} ${username ? `(@${username})` : ""}\nID: ${userId}\n\n`
  message += `Country: ${safe(session.data.country)}\nIssue: ${safe(session.data.issueType)}\nPayment: ${safe(session.data.paymentSystem)}\nGame User ID: ${safe(session.data.gameUserId)}`
  if (session.data.paymentSystem === 'binance') message += `\nBinance UID: ${safe(session.data.binanceUid)}`
  else if (session.data.paymentSystem === 'moneygo') message += `\nMoneyGo Number: ${safe(session.data.moneygoNumber)}`
  else message += `\nPhone: ${safe(session.data.phoneNumber)}\nAgent: ${safe(session.data.agentNumber)}\nTrx ID: ${safe(session.data.trxId)}`
  message += `\nAmount: ${safe(session.data.amount)}\nDate: ${safe(session.data.selectedDate)}`
  if (session.data.selectedTime) message += `\nTime: ${safe(session.data.selectedTime)}`

  for (const adminId of ADMIN_IDS) {
    try {
      if (session.data.fileType === "photo") {
        await bot.telegram.sendPhoto(adminId, session.data.fileId, {
          caption: message,
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 Reply", callback_data: `reply_${userId}` },
               { text: "✅ Resolve", callback_data: `resolve_${trackId}_${userId}` }]
            ]
          }
        })
      } else {
        await bot.telegram.sendVideo(adminId, session.data.fileId, {
          caption: message,
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 Reply", callback_data: `reply_${userId}` },
               { text: "✅ Resolve", callback_data: `resolve_${trackId}_${userId}` }]
            ]
          }
        })
      }
    } catch(e) { console.error("Failed to send to admin", e) }
  }

  ctx.reply(`✅ Ticket submitted.\nTrack ID: ${trackId}\nAdmin will respond soon.`, userMenu())
  clearSession(userId)
  await ctx.answerCbQuery()
})

bot.action("restart_player", async (ctx) => {
  if (!(await ensurePhone(ctx))) return
  const userId = ctx.from.id
  clearSession(userId)
  const session = getSession(userId)
  session.state = "player_country_selection"
  session.data.type = "player"
  await ctx.editMessageText(
    "👤 Player Support\n\nWhere are you from?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🇧🇩 Bangladesh", "player_select_bangladesh")],
      [Markup.button.callback("🇮🇳 India", "player_select_india")],
      [Markup.button.callback("« Back", "main_menu")]
    ])
  )
  await ctx.answerCbQuery()
})

// ================= TICKET LIST & ADMIN ACTIONS =================
function showTicketList(ctx, category, page) {
  const tickets = pendingTickets.filter(t => t.category === category && t.status === "open")
  const pageSize = 5
  const totalPages = Math.ceil(tickets.length / pageSize) || 1
  const start = page * pageSize
  const pageTickets = tickets.slice(start, start + pageSize)
  if (tickets.length === 0) {
    ctx.reply(`No open ${category} tickets.`)
    return
  }
  const buttons = []
  pageTickets.forEach(t => {
    const userDisplay = t.username ? `@${t.username}` : `ID: ${t.userId}`
    buttons.push([Markup.button.callback(`${t.trackId} - ${userDisplay}`, `view_${category}_${t.trackId}`)])
  })
  const nav = []
  if (page > 0) nav.push(Markup.button.callback("« Prev", `${category}_page_${page-1}`))
  nav.push(Markup.button.callback(`Page ${page+1}/${totalPages}`, "ignore"))
  if (page < totalPages-1) nav.push(Markup.button.callback("Next »", `${category}_page_${page+1}`))
  buttons.push(nav)
  buttons.push([Markup.button.callback("🔙 Main Menu", "main_menu")])
  ctx.reply(`📋 Open ${category === "deposit" ? "Deposit" : "Withdrawal"} Tickets:`, Markup.inlineKeyboard(buttons))
}

bot.action(/^(deposit|withdrawal)_page_(\d+)$/, async (ctx) => {
  const category = ctx.match[1]
  const page = parseInt(ctx.match[2])
  showTicketList(ctx, category, page)
  await ctx.answerCbQuery()
})

bot.action(/^view_(deposit|withdrawal)_(TKT-.+)$/, async (ctx) => {
  const category = ctx.match[1]
  const trackId = ctx.match[2]
  const ticket = pendingTickets.find(t => t.trackId === trackId && t.status === "open")
  if (!ticket) {
    await ctx.answerCbQuery("Ticket not found.")
    return ctx.editMessageText("Ticket not found.")
  }
  const data = ticket.data
  const user = ticket.username ? `@${ticket.username}` : `ID: ${ticket.userId}`
  const details = `<b>🎫 Ticket ${trackId}</b>

User: ${user}
Country: ${safe(data.country)}
Issue: ${safe(data.issueType)}
Payment: ${safe(data.paymentSystem)}
Game User ID: ${safe(data.gameUserId)}`
  let extra = ""
  if (data.paymentSystem === 'binance') extra = `\nBinance UID: ${safe(data.binanceUid)}`
  else if (data.paymentSystem === 'moneygo') extra = `\nMoneyGo: ${safe(data.moneygoNumber)}`
  else extra = `\nPhone: ${safe(data.phoneNumber)}\nAgent: ${safe(data.agentNumber)}\nTrx ID: ${safe(data.trxId)}`
  await ctx.editMessageText(details + extra + `\nAmount: ${safe(data.amount)}\nDate: ${safe(data.selectedDate)}` + (data.selectedTime ? `\nTime: ${safe(data.selectedTime)}` : "") + `\nFile: ${safe(data.fileName)}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 Reply", callback_data: `reply_${ticket.userId}` },
         { text: "✅ Resolve", callback_data: `resolve_${trackId}_${ticket.userId}` }],
        [{ text: "🔙 Back to list", callback_data: `${category}_page_0` }]
      ]
    }
  })
  await ctx.answerCbQuery()
})

bot.action(/resolve_(.+)_(\d+)/, async (ctx) => {
  const trackId = ctx.match[1]
  const userId = parseInt(ctx.match[2])
  const adminId = ctx.from.id
  const idx = pendingTickets.findIndex(t => t.trackId === trackId)
  if (idx !== -1) {
    pendingTickets.splice(idx, 1)
    saveTickets()
  }
  await ctx.answerCbQuery("Ticket resolved")
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
  await bot.telegram.sendMessage(userId, `✅ Your request ${trackId} has been resolved.\n\nPlease rate your experience:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("1⭐ Best", `rate_${trackId}_${adminId}_1`),
       Markup.button.callback("2⭐ Good", `rate_${trackId}_${adminId}_2`),
       Markup.button.callback("3⭐ Poor", `rate_${trackId}_${adminId}_3`)]
    ])
  )
})

bot.action(/rate_(.+)_(\d+)_(\d)/, async (ctx) => {
  const trackId = ctx.match[1]
  const adminId = parseInt(ctx.match[2])
  const rating = ctx.match[3]
  const userId = ctx.from.id
  const ratingText = rating === "1" ? "1⭐ Best" : rating === "2" ? "2⭐ Good" : "3⭐ Poor"
  await bot.telegram.sendMessage(adminId, `📊 User ${displayUser(ctx)} rated ticket ${trackId} as: ${ratingText}`)
  await ctx.editMessageText("Thank you for your feedback! 🙏")
  await ctx.answerCbQuery()
})

bot.action(/reply_(\d+)/, (ctx) => {
  const adminId = ctx.from.id
  if (!ADMIN_IDS.includes(adminId)) return ctx.answerCbQuery("Not authorized")
  const targetUserId = parseInt(ctx.match[1])
  const session = getSession(adminId)
  session.state = "admin_reply"
  session.data.targetUserId = targetUserId
  ctx.answerCbQuery()
  ctx.reply("✏️ Type your reply message below.")
})

// ================= BROADCAST CATEGORY SELECTION =================
bot.action(/broadcast_(all|players)/, async (ctx) => {
  const category = ctx.match[1]
  const adminId = ctx.from.id
  const session = getSession(adminId)
  session.state = "admin_broadcast_message"
  session.broadcastCategory = category
  await ctx.editMessageText(`📢 You selected: ${category === 'all' ? 'All Users' : 'Players'}.\nNow type the message or send a photo/video to broadcast.`)
  await ctx.answerCbQuery()
})

// ================= MAIN MENU ACTION =================
bot.action("main_menu", async (ctx) => {
  const userId = ctx.from.id
  clearSession(userId)
  await ctx.deleteMessage().catch(() => {})
  if (ADMIN_IDS.includes(userId)) {
    await ctx.reply("Admin menu:", adminMenu())
  } else {
    await ctx.reply("Main menu:", userMenu())
  }
  await ctx.answerCbQuery()
})

// ================= START BOT WITH CONFLICT HANDLING =================
async function startBot(retries = 5) {
  try {
    console.log("Deleting webhook and dropping pending updates...")
    await bot.telegram.deleteWebhook({ drop_pending_updates: true })
    console.log("Waiting 5 seconds for Telegram to release session...")
    await new Promise(r => setTimeout(r, 5000))
    console.log("Launching bot...")
    await bot.launch()
    console.log("🚀 Bot running (deposit/withdrawal support only)")
  } catch (err) {
    console.error("Failed to launch:", err)
    if (err.response?.error_code === 409 && retries > 0) {
      console.log(`Conflict – retrying in 15 seconds... (${retries} retries left)`)
      setTimeout(() => startBot(retries - 1), 15000)
    } else {
      console.error("Could not resolve conflict. Please scale down to 0 dynos, wait, then scale up to 1.")
      process.exit(1)
    }
  }
}
startBot()

process.on('unhandledRejection', console.error)
process.on('uncaughtException', console.error)
