require('dotenv').config(); // подтягиваем .env — обязательно первой строкой

const express = require('express');
const cors = require('cors');
const ordersRouter = require('./orders_api'); // подключаем наш файл с QR-заказами
const bookingsRouter = require('./bookings_api'); // подключаем эндпоинт бронирования с сайта
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const { createBooking } = require('./booking.js'); // импортируем функцию бронирования
const { sendGreenApiMessage } = require('./whatsapp.js'); // общий модуль WhatsApp

const app = express();

app.use(express.json()); // чтобы сервер понимал JSON-запросы от QR-страниц

// ==============================
// CORS — разрешаем запросы с сайта (Vercel) и локальной разработки
// ==============================
const ALLOWED_ORIGINS = [
  'https://grand-villa-site.vercel.app',
  'https://grand-villa-site-omvbgpqk3-aliaskar.vercel.app',
  'https://grand-villa-site-git-main-aliaskar.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    // origin === undefined бывает при запросах не из браузера (curl, Postman, вебхук Green-API) — разрешаем
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
}));

app.use(ordersRouter);   // активируем эндпоинты /api/orders из файла orders_api.js
app.use(bookingsRouter); // активируем эндпоинт /api/bookings из файла bookings_api.js

const PORT = process.env.PORT || 3000;

// ==============================
// КОНСТАНТЫ / КЛЮЧИ ДОСТУПА
// Все секреты теперь читаются из .env (см. .env.example)
// ==============================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Номер администратора для уведомлений о новых бронированиях
const ADMIN_PHONE = process.env.ADMIN_PHONE;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы в .env. Смотри .env.example.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });

const MAX_HISTORY_LENGTH = 20;

const SYSTEM_PROMPT = `Ты — Алия, ИИ-ассистентка ресепшена гостиницы "Гранд Вилла" в г. Туркестан, работаешь в WhatsApp.

СТИЛЬ: Пиши как опытный администратор ресепшена — коротко, по делу, без воды. 1-2 предложения на ответ. Максимум 1 эмодзи, и то не всегда. Язык строго зеркалит клиента: казахский → казахский, русский → русский, не смешивать.

ИНФОРМАЦИЯ О ГОСТИНИЦЕ:
- Стандарт — 20 000 ₸/сутки, Делюкс — 30 000 ₸/сутки, Семейный — 35 000 ₸/сутки
- Завтрак включён во все категории, бесплатный Wi-Fi по всей территории
- Заезд с 14:00, выезд до 12:00

БРОНИРОВАНИЕ:
Нужно узнать: имя, телефон, категория номера (стандарт, делюкс или семейный), дата заезда (в формате ГГГГ-ММ-ДД), количество ночей.

Главное правило — НЕ ВЕДИ ДОПРОС. Смотри, что клиент уже написал (в этом сообщении и раньше в переписке), и спрашивай только то, чего реально не хватает — одним компактным вопросом, а не по одному пункту за раз. Если клиент написал всё сразу — сразу переходи к подтверждению, не переспрашивай то, что уже сказано.

Как только есть все данные — одной фразой подтверди детали клиенту, а сразу следом, на новой строке, добавь маркер (клиент его не видит, объяснять не нужно):
[[BOOKING_READY]]{"name": "Имя", "phone": "Телефон", "service": "Категория", "checkin_date": "YYYY-MM-DD", "nights": 1}[[/BOOKING_READY]]

Не выдумывай услуги и акции, которых нет в списке выше.`;

const QUOTA_ERROR_TEMPLATE = `Саламатсыз ба! 😊 Қазір жүйеде техникалық жұмыстар жүріп жатыр. Кәдімгі нөмірге хабарласыңыз.\n\nЗдравствуйте! Сейчас на линии ИИ техническая перезагрузка. Пожалуйста, попробуйте позже.`;

const MAPS_REFERRAL_TEMPLATE = `Саламатсыз ба! 😊 Рахмет, уақыт бөліп бізді 2ГИС-тен тапқаныңызға! Мен "Гранд Вилла" гостиницасының ИИ-көмекшісімін.\n\nЗдравствуйте! Спасибо, что нашли нас в 2ГИС. Я ИИ-ассистент гостиницы "Гранд Вилла". Подскажите, пожалуйста, на какие даты вы планируете поездку и какая категория номера вас интересует?`;

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

    if (error || !data) {
      console.error('❌ Ошибка при загрузке истории:', error?.message);
      return [];
    }

    return data
      .reverse()
      .map(item => ({
        role: item.role === 'model' ? 'assistant' : item.role,
        content: item.content || ''
      }));
  } catch (e) {
    console.error('❌ Критическая ошибка при загрузке истории:', e.message);
    return [];
  }
}

async function saveMessageToDB(chatId, role, content) {
  if (!content) return;
  const { error } = await supabase
    .from('chat_history')
    .insert([{ chat_id: chatId, role, content }]);

  if (error) {
    console.error('❌ Ошибка при сохранении сообщения в chat_history:', error.message);
  }
}

// sendGreenApiMessage теперь импортируется из whatsapp.js (см. require выше) —
// один и тот же модуль используют и диалоги с гостями, и уведомления о QR-заказах.

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
    console.error('⚠️ Не удалось распарсить JSON заявки:', err.message);
  }
  return { cleanText, booking };
}

async function notifyAdminAboutBooking(booking, guestChatId, roomNumber = '—') {
  if (!ADMIN_PHONE) {
    console.log('⚠️ ADMIN_PHONE не задан — уведомление администратору не отправлено.');
    return;
  }

  const guestPhone = guestChatId?.split('@')[0] || 'неизвестен';

  const notificationText =
    `🚀 НОВАЯ ЗАЯВКА НА БРОНЬ — "Гранд Вилла"\n\n` +
    `🚪 Номер комнаты: ${roomNumber}\n` +
    `👤 Имя: ${booking.name || '—'}\n` +
    `📞 Телефон: ${booking.phone || '—'}\n` +
    `🛏 Категория: ${booking.service || '—'}\n` +
    `📅 Заезд: ${booking.checkin_date || '—'}\n` +
    `🌙 Ночей: ${booking.nights || '—'}\n\n` +
    `💬 Чат клиента (WhatsApp): ${guestPhone}`;

  console.log(`📨 Отправляю уведомление админу на номер: ${ADMIN_PHONE}`);
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

// ==============================
// ОБРАБОТКА ОДНОГО СООБЩЕНИЯ
// ==============================

async function handleIncomingMessage(body) {
  if (!body || body.typeWebhook !== 'incomingMessageReceived') return;

  const chatId = body.senderData?.chatId;
  if (!chatId) return;
  if (chatId.endsWith('@g.us')) return; 

  const userText = extractMessageText(body.messageData);
  if (!userText) return; 

  const lowerText = userText.toLowerCase();

  console.log(`\n📩 Входящее от [${chatId}]: ${userText}`);

  if (lowerText.includes('2гис') || lowerText.includes('2gis') || lowerText.includes('нашел вас в')) {
    await sendGreenApiMessage(chatId, MAPS_REFERRAL_TEMPLATE);
    await saveMessageToDB(chatId, 'user', userText);
    await saveMessageToDB(chatId, 'model', MAPS_REFERRAL_TEMPLATE);
    return;
  }

  await saveMessageToDB(chatId, 'user', userText);
  const dbHistory = await getAIHistory(chatId);

  const messagesForGroq = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...dbHistory
  ];

  let aiText = '';
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: messagesForGroq,
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens: 1024
    });
    aiText = chatCompletion.choices[0]?.message?.content?.trim() || '';
  } catch (groqErr) {
    console.error('❌ Ошибка Groq API:', groqErr.message);
    aiText = QUOTA_ERROR_TEMPLATE;
  }

  if (!aiText) {
    console.log(`⚠️ ИИ вернул пустой текст для [${chatId}]`);
    return;
  }

  const { cleanText, booking } = extractBooking(aiText);

  await sendGreenApiMessage(chatId, cleanText);
  await saveMessageToDB(chatId, 'model', aiText);
  console.log(`🤖 Ответил для [${chatId}]: ${cleanText}`);

  // Если ИИ зафиксировал готовность брони
  if (booking) {
    console.log('📋 Извлечена заявка из ответа ИИ:', JSON.stringify(booking));

    try {
      // 1. Рассчитываем дату выезда на основе checkin_date и количества ночей.
      // Считаем в UTC явно (getUTCDate/setUTCDate), чтобы результат не зависел
      // от таймзоны сервера — иначе на серверах не в UTC возможен сдвиг на день.
      const checkInDate = new Date(booking.checkin_date + 'T00:00:00Z');
      const nightsCount = parseInt(booking.nights) || 1;
      const checkOutDate = new Date(checkInDate);
      checkOutDate.setUTCDate(checkOutDate.getUTCDate() + nightsCount);

      const checkInStr = booking.checkin_date; // YYYY-MM-DD
      const checkOutStr = checkOutDate.toISOString().split('T')[0]; // YYYY-MM-DD

      // Map-индикатор типов комнат под базу данных
      let roomTypeSearch = 'standard';
      const serviceLower = (booking.service || '').toLowerCase();
      if (serviceLower.includes('делюкс') || serviceLower.includes('deluxe')) roomTypeSearch = 'deluxe';
      if (serviceLower.includes('семейный') || serviceLower.includes('suite') || serviceLower.includes('family')) roomTypeSearch = 'suite';

      // 2. Ищем СВОБОДНУЮ комнату нужного типа в облаке Supabase
      const { data: allRooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id, room_number')
        .eq('type', roomTypeSearch)
        .eq('is_active', true);

      if (roomsError || !allRooms || allRooms.length === 0) {
        throw new Error('Нет доступных комнат выбранной категории в базе данных.');
      }

      let targetRoom = null;

      // Проверяем каждую комнату этого типа на овербукинг через существующие брони
      for (const room of allRooms) {
        const { data: conflicts } = await supabase
          .from('bookings')
          .select('id')
          .eq('room_id', room.id)
          .eq('status', 'confirmed')
          .lt('check_in', checkOutStr)
          .gt('check_out', checkInStr);

        if (!conflicts || conflicts.length === 0) {
          targetRoom = room; // Нашли свободную комнату!
          break;
        }
      }

      if (!targetRoom) {
        await sendGreenApiMessage(chatId, "К сожалению, все номера этой категории на выбранные даты уже заняты.");
        return;
      }

      // 3. Вызываем твою защищенную функцию создания бронирования из booking.js
      const bookingResult = await createBooking({
        roomId: targetRoom.id,
        guestName: booking.name,
        guestPhone: booking.phone,
        checkIn: checkInStr,
        checkOut: checkOutStr
      });

      if (bookingResult.success) {
        console.log(`💾 ЗАЯВКА УСПЕШНО СОХРАНЕНА ЧЕРЕЗ КЛАСС БРОНИРОВАНИЯ: ${booking.name}`);
        // Уведомляем администратора о брони с указанием конкретной комнаты
        await notifyAdminAboutBooking(booking, chatId, targetRoom.room_number);
      } else {
        console.error('❌ База данных отклонила бронь:', bookingResult.error);
        await sendGreenApiMessage(chatId, `Ошибка бронирования: ${bookingResult.error}`);
      }

    } catch (err) {
      console.error('❌ Ошибка в процессе автоматического бронирования:', err.message);
      // Если автоматика дала сбой, всё равно уведомляем админа, чтобы не потерять лида
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
    console.error('❌ Критическая ошибка в /webhook:', error.message);
    res.sendStatus(200); 
  }
});

app.get('/', (req, res) => {
  res.send('Grand Villa WhatsApp bot backend is running (Green API).');
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook сервер бота успешно запущен на порту ${PORT}`);
});