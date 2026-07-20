require('dotenv').config(); // подтягиваем .env — обязательно первой строкой

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const ordersRouter = require('./orders_api');
const bookingsRouter = require('./bookings_api');
const roomsRouter = require('./rooms_api');
const { getRoomsAvailability } = require('./rooms_api');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { createBooking } = require('./booking.js');
const { sendGreenApiMessage } = require('./whatsapp.js');

const app = express();

app.use(express.json());

// ==============================
// CORS — разрешаем запросы с сайта (Vercel) и локальной разработки
// ==============================
const ALLOWED_ORIGINS = [
  'https://grand-villa-site.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
}));

app.use(ordersRouter);   
app.use(bookingsRouter); 
app.use(roomsRouter);    

const PORT = process.env.PORT || 3000;

// ==============================
// КОНСТАНТЫ / КЛЮЧИ ДОСТУПА
// ==============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const ADMIN_PHONE = process.env.ADMIN_PHONE;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы в .env!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const MAX_HISTORY_LENGTH = 20;

const SYSTEM_PROMPT = `Ты — Алия, ИИ-ассистентка ресепшена гостиницы "Гранд Вилла" в г. Туркестан, работаешь в WhatsApp.

СТИЛЬ: Пиши как опытный администратор ресепшена — коротко, по делу, без воды. 1-2 предложения на ответ. Максимум 1 эмодзи. Язык строго зеркалит клиента: казахский → казахский, русский → русский, не смешивать. Казахскую речь формируй грамотно и вежливо.

ИНФОРМАЦИЯ О ГОСТИНИЦЕ:
- Стандарт — 20 000 ₸/сутки, Делюкс — 30 000 ₸/сутки, Семейный — 35 000 ₸/сутки
- Завтрак включён во все категории, бесплатный Wi-Fi по всей территории
- Заезд с 14:00, выезд до 12:00

ОТПРАВКА ДОКУМЕНТОВ И ФАЙЛОВ (КРИТИЧЕСКИ ВАЖНО):
Если гость отправляет документы (удостоверение, паспорт, чек, квитанцию, фото) или пишет, что отправил/хочет отправить документы, ТЕБЕ ЗАПРЕЩЕНО обрабатывать их самостоятельно!
1. Напиши: "Спасибо за предоставленные данные/документы. Передаю их администратору, он всё проверит и свяжется с вами в ближайшее время."
2. Строго на новой строке в конце выведи маркер: [[DOCUMENTS_RECEIVED_ALERT]]

ФИЛЬТР ГРУППОВЫХ И ЮР. ЗАЯВОК (КРИТИЧЕСКИ ВАЖНО):
Если клиент планирует заселить группу (более 5 человек) или представляет организацию (футбольная команда, компания, юрлицо, госструктура), ТЕБЕ ЗАПРЕЩЕНО вести бронирование самостоятельно! Ты должна вежливо спросить:
1) Сколько планируется персон для заселения?
2) Является ли гость представителем юридического лица / организации?

Если подтверждается группа (>5 человек) или юрлицо/организация:
1. Мгновенно останови диалог.
2. Напиши клиенту вежливый ответ: "Ваш запрос требует индивидуального согласования. Сейчас с вами напрямую свяжется наш старший администратор и предложит лучшие условия."
3. Строго на новой строке в самом конце сообщения выведи маркер для бэкенда: [[GROUP_BOOKING_ALERT]]

ВОПРОСЫ О ТРУДОУСТРОЙСТВЕ И ВАКАНСИЯХ (КРИТИЧЕСКИ ВАЖНО):
Если гость/клиент спрашивает о работе в гостинице, наличии вакансий, хочет отправить резюме или устроиться на работу (повар, горничная, администратор, охранник и т.д.), ТЕБЕ ЗАПРЕЩЕНО обсуждать условия работы самостоятельно!
1. Ответь вежливо: "По вопросам трудоустройства и вакансий с вами напрямую свяжется наш администратор/управляющий."
2. Строго на новой строке в самом конце сообщения выведи маркер для бэкенда: [[JOB_INQUIRY_ALERT]]

ОБЫЧНОЕ БРОНИРОВАНИЕ (до 5 человек, физлица):
Нужно узнать: имя, телефон, категория номера (стандарт, делюкс или семейный), дата заезда в любом формате, количество ночей.
НЕ ВЕДИ ДОПРОС. Спрашивай только то, чего не хватает, компактно. Если всё есть — давай подтверждение с маркером:
[[BOOKING_READY]]{"name": "Имя", "phone": "Телефон", "service": "Категория", "checkin_date": "YYYY-MM-DD", "nights": 1}[[/BOOKING_READY]]`;

const QUOTA_ERROR_TEMPLATE = `Саламатсыз ба! 😊 Қазір жүйеде техникалық жұмыстар жүріп жатыр. Кәдімгі нөмірге хабарласыңыз.\n\nЗдравствуйте! Сейчас на линии ИИ техническая перезагрузка. Пожалуйста, попробуйте позже.`;

const MAPS_REFERRAL_TEMPLATE = `Саламатсыз ба! 😊 Рахмет, уақыт бөліп бізді 2ГИС-тен тапқаныңызға! Мен "Гранд Вилла" гостиницасының ИИ-көмекшісімін.\n\nЗдравствуйте! Спасибо, что нашли нас в 2ГИС. Я ИИ-ассистент гостиницы "Гранд Вилла". Подскажите, пожалуйста, на какие даты вы планируете поездку и какая категория номера вас интересует?`;

// ==============================
// АВТОМАТИЧЕСКИЙ ВЫЕЗД ПОСЛЕ 12:00 (CRON TASK)
// ==============================
cron.schedule('0 * * * *', async () => {
  console.log('🔄 [CRON] Проверка времени выезда (Check-out)...');
  
  const now = new Date();
  if (now.getHours() < 12) return;

  try {
    const todayStr = now.toISOString().split('T')[0];

    const { data: activeBookings, error: fetchError } = await supabase
      .from('bookings')
      .select('id, room_id, check_out, guest_name')
      .eq('status', 'confirmed')
      .lte('check_out', todayStr);

    if (fetchError) throw fetchError;

    if (activeBookings && activeBookings.length > 0) {
      const expiredBookingIds = [];

      for (const booking of activeBookings) {
        const checkOutDeadline = new Date(`${booking.check_out}T12:00:00`);
        if (now >= checkOutDeadline) {
          expiredBookingIds.push(booking.id);
        }
      }

      if (expiredBookingIds.length > 0) {
        await supabase
          .from('bookings')
          .update({ status: 'completed' })
          .in('id', expiredBookingIds);

        console.log(`✅ [CRON] ${expiredBookingIds.length} броней завершено.`);

        if (ADMIN_PHONE) {
          await sendGreenApiMessage(
            `${ADMIN_PHONE}@c.us`, 
            `🔔 Системное уведомление: Выезд (12:00). В базе данных автоматически завершено бронирований: ${expiredBookingIds.length}.`
          );
        }
      }
    }
  } catch (err) {
    console.error('❌ Ошибка [CRON]:', err.message);
  }
});

// ==============================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==============================

async function getAIHistory(chatId) {
  try {
    const { data, error } = await supabase
      .from('chat_history')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY_LENGTH);

    if (error || !data) return [];

    return data
      .reverse()
      .map(item => ({
        role: item.role === 'model' ? 'assistant' : item.role,
        content: item.content || ''
      }));
  } catch (e) {
    console.error('❌ Ошибка загрузки истории:', e.message);
    return [];
  }
}

async function saveMessageToDB(chatId, role, content) {
  if (!content) return;
  await supabase.from('chat_history').insert([{ chat_id: chatId, role, content }]);
}

function extractBooking(aiText) {
  if (!aiText) return { cleanText: '', booking: null };
  const regex = /\[\[BOOKING_READY\]\]([\s\S]*?)\[\[\/BOOKING_READY\]\]/;
  const match = aiText.match(regex);
  if (!match) return { cleanText: aiText.trim(), booking: null };

  const cleanText = aiText.replace(regex, '').trim();
  let booking = null;
  try {
    booking = JSON.parse(match[1].trim());
  } catch (err) {
    console.error('⚠️ Ошибка парсинга JSON заявки:', err.message);
  }
  return { cleanText, booking };
}

async function notifyAdminAboutBooking(booking, guestChatId, roomNumber = '—') {
  if (!ADMIN_PHONE) return;

  const guestPhone = guestChatId?.split('@')[0] || 'неизвестен';

  const notificationText =
    `🚀 НОВАЯ ЗАЯВКА НА БРОНЬ — "Гранд Вилла"\n\n` +
    `🚪 Номер комнаты: ${roomNumber}\n` +
    `👤 Имя: ${booking.name || '—'}\n` +
    `📞 Телефон: ${booking.phone || '—'}\n` +
    `🛏 Категория: ${booking.service || '—'}\n` +
    `📅 Заезд: ${booking.checkin_date || '—'}\n` +
    `🌙 Ночей: ${booking.nights || '—'}\n\n` +
    `💬 Чат клиента (WhatsApp): +${guestPhone}`;

  await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, notificationText);
}

function extractMessageText(messageData) {
  if (!messageData) return null;
  if (messageData.typeMessage === 'textMessage') {
    return messageData.textMessageData?.textMessage?.trim() || null;
  }
  if (messageData.typeMessage === 'extendedTextMessage') {
    return messageData.extendedTextMessageData?.text?.trim() || null;
  }
  if (messageData.fileMessageData?.caption) {
    return messageData.fileMessageData.caption.trim();
  }
  return null;
}

const ROOM_TYPE_LABELS = { standard: 'Стандарт', deluxe: 'Делюкс', suite: 'Семейный' };

async function buildAvailabilityContext() {
  try {
    const rooms = await getRoomsAvailability();
    if (!rooms || rooms.length === 0) return '';

    const grouped = {};
    for (const room of rooms) {
      if (!grouped[room.type]) grouped[room.type] = { total: 0, free: 0 };
      grouped[room.type].total += 1;
      if (room.is_available) grouped[room.type].free += 1;
    }

    const lines = Object.entries(grouped).map(
      ([type, { total, free }]) => `- ${ROOM_TYPE_LABELS[type] || type}: свободно ${free} из ${total}`
    );

    const today = new Date().toISOString().split('T')[0];
    return `\n\nАКТУАЛЬНАЯ ЗАНЯТОСТЬ НОМЕРОВ (на сегодня, ${today}):\n${lines.join('\n')}\n`;
  } catch (err) {
    return '';
  }
}

// ==============================
// ОБРАБОТКА ВХОДЯЩЕГО СООБЩЕНИЯ
// ==============================
async function handleIncomingMessage(body) {
  if (!body || body.typeWebhook !== 'incomingMessageReceived') return;

  const chatId = body.senderData?.chatId;
  if (!chatId || chatId.endsWith('@g.us')) return; 

  // 1. ПРОВЕРКА ОТПРАВКИ ФАЙЛОВ / ФОТО / ДОКУМЕНТОВ
  const messageType = body.messageData?.typeMessage;
  const isMediaOrFile = ['imageMessage', 'documentMessage', 'fileMessage'].includes(messageType);
  
  if (isMediaOrFile) {
    console.log(`📄 Получен документ/файл от [${chatId}]`);
    await saveMessageToDB(chatId, 'user', '[Отправлен файл/фото/документ]');
    await saveMessageToDB(chatId, 'system', '[AI_DISABLED]');

    const replyText = 
      `Рахмет! Құжаттарыңыз/файлыңыз қабылданды. Қазір администратор тексеріп, сізге жауап береді. 😊\n\n` +
      `Спасибо! Ваши документы/файл получены. Передаю их администратору, он проверит и ответит вам в ближайшее время.`;

    await sendGreenApiMessage(chatId, replyText);
    await saveMessageToDB(chatId, 'model', replyText);

    if (ADMIN_PHONE) {
      const guestPhone = chatId.split('@')[0];
      const alertAdminText = 
        `📄 СРОЧНО: Клиент прислал документ / фото / чек!\n\n` +
        `📞 Номер: +${guestPhone}\n\n` +
        `🤖 Бот отключен. Проверьте чат в WhatsApp и ответьте гостю. Чтобы запустить бота обратно, отправьте: "Алия включись"`;
      
      await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, alertAdminText);
    }
    return;
  }

  const userText = extractMessageText(body.messageData);
  if (!userText) return; 

  const lowerText = userText.toLowerCase();
  console.log(`\n📩 Входящее от [${chatId}]: ${userText}`);

  // 2. Проверка блокировки ИИ (ручной режим)
  const { data: lastSystemMsg } = await supabase
    .from('chat_history')
    .select('content')
    .eq('chat_id', chatId)
    .eq('role', 'system')
    .order('created_at', { ascending: false })
    .limit(1);

  if (lastSystemMsg && lastSystemMsg[0]?.content === '[AI_DISABLED]') {
    if (lowerText === 'алия включись' || lowerText === 'алия работай') {
      await saveMessageToDB(chatId, 'system', '[AI_ENABLED]');
      await sendGreenApiMessage(chatId, '🤖 ИИ-ассистент снова на связи!');
      return;
    }
    console.log(`🤫 ИИ отключен для [${chatId}], диалог ведут вручную.`);
    return;
  }

  // 3. Вызов оператора человеком
  const humanRequests = ['администратор', 'админ', 'человек', 'оператор', 'менеджер', 'ресепшен', 'позови', 'адам', 'администраторды'];
  if (humanRequests.some(word => lowerText.includes(word))) {
    await saveMessageToDB(chatId, 'user', userText);
    await saveMessageToDB(chatId, 'system', '[AI_DISABLED]');

    const replyText = `Саламатсыз ба! Қазір сізге администратор жауап береді. Күте тұрыңыз... 😊\n\nЗдравствуйте! Передаю диалог администратору. Он ответит вам в ближайшее время.`;
    await sendGreenApiMessage(chatId, replyText);
    await saveMessageToDB(chatId, 'model', replyText);

    if (ADMIN_PHONE) {
      const guestPhone = chatId.split('@')[0];
      await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, `⚠️ СРОЧНО: Клиент просит администратора!\n📞 Номер: +${guestPhone}\n💬 Сообщение: "${userText}"\n\nЧтобы вернуть бота, отправьте: "Алия включись"`);
    }
    return;
  }

  // 4. Переход из 2ГИС
  if (lowerText.includes('2гис') || lowerText.includes('2gis') || lowerText.includes('нашел вас в')) {
    await sendGreenApiMessage(chatId, MAPS_REFERRAL_TEMPLATE);
    await saveMessageToDB(chatId, 'user', userText);
    await saveMessageToDB(chatId, 'model', MAPS_REFERRAL_TEMPLATE);
    return;
  }

  // 5. Генерация ответа ИИ через OpenAI
  await saveMessageToDB(chatId, 'user', userText);
  const dbHistory = await getAIHistory(chatId);
  const availabilityContext = await buildAvailabilityContext();

  const messagesForOpenAI = [
    { role: 'system', content: SYSTEM_PROMPT + availabilityContext },
    ...dbHistory
  ];

  let aiText = '';
  try {
    const chatCompletion = await openai.chat.completions.create({
      messages: messagesForOpenAI,
      model: OPENAI_MODEL,
      temperature: 0.5,
      max_tokens: 1024
    });
    aiText = chatCompletion.choices[0]?.message?.content?.trim() || '';
  } catch (openaiErr) {
    console.error('❌ Ошибка OpenAI API:', openaiErr.message);
    aiText = QUOTA_ERROR_TEMPLATE;
  }

  if (!aiText) return;

  const { cleanText, booking } = extractBooking(aiText);
  const isGroupRequest = aiText.includes('[[GROUP_BOOKING_ALERT]]');
  const isDocAlert = aiText.includes('[[DOCUMENTS_RECEIVED_ALERT]]');

  const textToSend = cleanText
    .replace('[[GROUP_BOOKING_ALERT]]', '')
    .replace('[[DOCUMENTS_RECEIVED_ALERT]]', '')
    .trim();

  await sendGreenApiMessage(chatId, textToSend);
  await saveMessageToDB(chatId, 'model', aiText);
  console.log(`🤖 Ответил для [${chatId}]: ${textToSend}`);

  // Если от ИИ пришел маркер документов — отключаем ИИ и зовем админа
  if (isDocAlert) {
    await saveMessageToDB(chatId, 'system', '[AI_DISABLED]');
    if (ADMIN_PHONE) {
      const guestPhone = chatId.split('@')[0] || 'неизвестен';
      await sendGreenApiMessage(
        `${ADMIN_PHONE}@c.us`, 
        `📄 СРОЧНО: Гость сообщил об отправке документов/чека!\n📞 Номер: +${guestPhone}\n\n🤖 Бот отключен. Напишите гостю вручную.`
      );
    }
  }

  // Если это групповой запрос — предупреждаем администратора
  if (isGroupRequest) {
    await saveMessageToDB(chatId, 'system', '[AI_DISABLED]');
    console.log(`🚨 Групповая/Юр. заявка для чата [${chatId}]!`);
    if (ADMIN_PHONE) {
      const guestPhone = chatId.split('@')[0] || 'неизвестен';
      const adminAlertText = 
        `🚨 СРОЧНЫЙ ВЫЗОВ — "Гранд Вилла"\n\n` +
        `👤 Гость интересуется групповым заселением или бронированием на юрлицо!\n` +
        `📞 Номер телефона гостя: +${guestPhone}\n\n` +
        `⚠️ ИИ остановил переписку. Пожалуйста, свяжитесь с гостем напрямую!`;
      
      await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, adminAlertText);
    }
  }

  // 6. Автобронирование в БД
  if (booking) {
    try {
      const checkInDate = new Date(booking.checkin_date + 'T00:00:00Z');
      const nightsCount = parseInt(booking.nights) || 1;
      const checkOutDate = new Date(checkInDate);
      checkOutDate.setUTCDate(checkOutDate.getUTCDate() + nightsCount);

      const checkInStr = booking.checkin_date;
      const checkOutStr = checkOutDate.toISOString().split('T')[0];

      let roomTypeSearch = 'standard';
      const serviceLower = (booking.service || '').toLowerCase();
      if (serviceLower.includes('делюкс') || serviceLower.includes('deluxe')) roomTypeSearch = 'deluxe';
      if (serviceLower.includes('семейный') || serviceLower.includes('suite') || serviceLower.includes('family')) roomTypeSearch = 'suite';

      const { data: allRooms } = await supabase
        .from('rooms')
        .select('id, room_number')
        .eq('type', roomTypeSearch)
        .eq('is_active', true);

      if (!allRooms || allRooms.length === 0) throw new Error('Нет доступных комнат выбранной категории.');

      let targetRoom = null;
      for (const room of allRooms) {
        const { data: conflicts } = await supabase
          .from('bookings')
          .select('id')
          .eq('room_id', room.id)
          .eq('status', 'confirmed')
          .lt('check_in', checkOutStr)
          .gt('check_out', checkInStr);

        if (!conflicts || conflicts.length === 0) {
          targetRoom = room;
          break;
        }
      }

      if (!targetRoom) {
        await sendGreenApiMessage(chatId, "К сожалению, все номера этой категории на выбранные даты уже заняты.");
        return;
      }

      const bookingResult = await createBooking({
        roomId: targetRoom.id,
        guestName: booking.name,
        guestPhone: booking.phone,
        checkIn: checkInStr,
        checkOut: checkOutStr
      });

      if (bookingResult.success) {
        await notifyAdminAboutBooking(booking, chatId, targetRoom.room_number);
      }
    } catch (err) {
      console.error('❌ Ошибка бронирования:', err.message);
      await notifyAdminAboutBooking(booking, chatId, 'Ошибка автоподбора');
    }
  }
}

// ==============================
// ЭНДПОИНТ /webhook
// ==============================
app.post('/webhook', async (req, res) => {
  try {
    await handleIncomingMessage(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в /webhook:', error.message);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => {
  res.send('Grand Villa WhatsApp bot backend is running (Green API & OpenAI).');
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook сервер бота успешно запущен на порту ${PORT}`);
});