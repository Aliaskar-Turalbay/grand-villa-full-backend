require('dotenv').config(); // подтягиваем .env — обязательно первой строкой

const express = require('express');
const cors = require('cors');
const cron = require('node-cron'); // Подключаем планировщик задач
const ordersRouter = require('./orders_api'); // подключаем наш файл с QR-заказами
const bookingsRouter = require('./bookings_api'); // подключаем эндпоинт бронирования с сайта
const { getRoomsAvailability } = require('./rooms_api'); // общая занятость номеров (используем и как роут, и как функцию)
const roomsRouter = require('./rooms_api');
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

app.use(ordersRouter);   // активируем эндпоинты /api/orders из файла orders_api.js
app.use(bookingsRouter); // активируем эндпоинт /api/bookings из файла bookings_api.js
app.use(roomsRouter);    // активируем эндпоинт /api/rooms/availability из файла rooms_api.js

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

ТЕЛЕФОН ОБЯЗАТЕЛЕН. Без номера телефона бронь оформить нельзя — это правило без исключений. Если клиент называет все остальные данные, но не оставил телефон, не отправляй маркер [[BOOKING_READY]] — вежливо попроси телефон отдельным вопросом ("Оставьте, пожалуйста, номер телефона для подтверждения брони") и жди ответа. Если клиент уклоняется или спрашивает "зачем" — коротко объясни: номер нужен, чтобы администратор мог подтвердить бронь и связаться в случае вопросов.

Главное правило — НЕ ВЕДИ ДОПРОС. Смотри, что клиент уже написал (в этом сообщении и раньше в переписке), и спрашивай только то, чего реально не хватает — одним компактным вопросом, а не по одному пункту за раз. Если клиент написал всё сразу — сразу переходи к подтверждению, не переспрашивай то, что уже сказано.

Как только есть все данные — одной фразой подтверди детали клиенту, а сразу следом, на новой строке, добавь маркер (клиент его не видит, объяснять не нужно):
[[BOOKING_READY]]{"name": "Имя", "phone": "Телефон", "service": "Категория", "checkin_date": "YYYY-MM-DD", "nights": 1}[[/BOOKING_READY]]

Не выдумывай услуги и акции, которых нет в списке выше.`;

const QUOTA_ERROR_TEMPLATE = `Саламатсыз ба! 😊 Қазір жүйеде техникалық жұмыстар жүріп жатыр. Кәдімгі нөмірге хабарласыңыз.\n\nЗдравствуйте! Сейчас на линии ИИ техническая перезагрузка. Пожалуйста, попробуйте позже.`;

const MAPS_REFERRAL_TEMPLATE = `Саламатсыз ба! 😊 Рахмет, уақыт бөліп бізді 2ГИС-тен тапқаныңызға! Мен "Гранд Вилла" гостиницасының ИИ-көмекшісімін.\n\nЗдравствуйте! Спасибо, что нашли нас в 2ГИС. Я ИИ-ассистент гостиницы "Гранд Вилла". Подскажите, пожалуйста, на какие даты вы планируете поездку и какая категория номера вас интересует?`;

// ==============================
// АВТОМАТИЧЕСКИЙ ВЫЕЗД ПОСЛЕ 12:00 (CRON TASK)
// ==============================
// Запуск скрипта каждый час в 00 минут (например, 12:00, 13:00, 14:00 и т.д.)
cron.schedule('0 * * * *', async () => {
  console.log('🔄 [CRON] Запуск плановой проверки времени выезда (Check-out)...');
  
  const now = new Date();
  const currentHour = now.getHours();

  // Если время еще не дошло до 12:00 обеда, проверку пропускаем
  if (currentHour < 12) {
    console.log('--- [CRON] Время выезда (12:00) для сегодняшнего дня еще не наступило. ---');
    return;
  }

  try {
    // Получаем сегодняшнюю дату в формате YYYY-MM-DD
    const todayStr = now.toISOString().split('T')[0];

    // Выбираем из базы все бронирования, у которых дата check_out уже наступила или прошла,
    // но статус всё еще 'confirmed'
    const { data: activeBookings, error: fetchError } = await supabase
      .from('bookings')
      .select('id, room_id, check_out, guest_name')
      .eq('status', 'confirmed')
      .lte('check_out', todayStr);

    if (fetchError) throw fetchError;

    if (activeBookings && activeBookings.length > 0) {
      const expiredBookingIds = [];
      const roomsToFree = [];

      for (const booking of activeBookings) {
        // Устанавливаем точный лимит выезда на 12:00:00 для даты выезда
        const checkOutDeadline = new Date(`${booking.check_out}T12:00:00`);

        // Если текущее время больше или равно 12:00 дня выезда гостя
        if (now >= checkOutDeadline) {
          expiredBookingIds.push(booking.id);
          roomsToFree.push(booking.room_id);
          console.log(`⏳ Обнаружен выезд: Гость ${booking.guest_name} должен освободить комнату ID: ${booking.room_id} (Дата выезда: ${booking.check_out} после 12:00)`);
        }
      }

      if (expiredBookingIds.length > 0) {
        // 1. Переводим завершенные бронирования из 'confirmed' в 'completed'
        const { error: updateBookingError } = await supabase
          .from('bookings')
          .update({ status: 'completed' })
          .in('id', expiredBookingIds);

        if (updateBookingError) throw updateBookingError;

        console.log(`✅ [CRON] ${expiredBookingIds.length} бронирований успешно переведены в статус 'completed'.`);

        // 2. Отправляем короткое сводное уведомление администратору в WhatsApp через Green-API
        if (ADMIN_PHONE) {
          const notificationText = `🔔 Системное уведомление: Наступило время выезда (12:00). В базе данных завершено бронирований: ${expiredBookingIds.length}.`;
          await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, notificationText);
        }
      } else {
        console.log('--- [CRON] Сегодняшние бронирования еще не достигли лимита 12:00. ---');
      }
    } else {
      console.log('--- [CRON] Нет активных броней со статусом "confirmed" на дату выезда. ---');
    }
  } catch (err) {
    console.error('❌ Ошибка выполнения [CRON] автовыселения:', err.message);
  }
});

// ==============================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ БОТА
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
    return (
      `\n\nАКТУАЛЬНАЯ ЗАНЯТОСТЬ НОМЕРОВ (на сегодня, ${today}):\n${lines.join('\n')}\n` +
      `Используй эти цифры, если гость спрашивает про наличие свободных номеров прямо сейчас. ` +
      `Финальную проверку на конкретные даты брони всё равно выполняет система автоматически при создании брони.`
    );
  } catch (err) {
    console.error('⚠️ Не удалось получить занятость номеров для контекста ИИ:', err.message);
    return '';
  }
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
  const availabilityContext = await buildAvailabilityContext();

  const messagesForGroq = [
    { role: 'system', content: SYSTEM_PROMPT + availabilityContext },
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

  if (booking) {
    console.log('📋 Извлечена заявка из ответа ИИ:', JSON.stringify(booking));

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

      const { data: allRooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id, room_number')
        .eq('type', roomTypeSearch)
        .eq('is_active', true);

      if (roomsError || !allRooms || allRooms.length === 0) {
        throw new Error('Нет доступных комнат выбранной категории в базе данных.');
      }

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
        console.log(`💾 ЗАЯВКА УСПЕШНО СОХРАНЕНА ЧЕРЕЗ КЛАСС БРОНИРОВАНИЯ: ${booking.name}`);
        await notifyAdminAboutBooking(booking, chatId, targetRoom.room_number);
      } else {
        console.error('❌ База данных отклонила бронь:', bookingResult.error);
        await sendGreenApiMessage(chatId, `Ошибка бронирования: ${bookingResult.error}`);
      }

    } catch (err) {
      console.error('❌ Ошибка в процессе автоматического бронирования:', err.message);
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