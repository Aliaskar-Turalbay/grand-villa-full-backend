// ============================================================
// bookings_api.js
// Express-эндпоинт для приёма бронирований С САЙТА (лендинг).
// Гость заполняет форму на сайте -> POST /api/bookings ->
//   1) подбор свободного номера нужной категории на эти даты
//   2) создание брони через защищённую функцию createBooking() из booking.js
//   3) уведомление администратора в WhatsApp
//
// Это отдельный путь от WhatsApp-бота Алии (там свой флоу в index.js),
// но оба в итоге используют одну и ту же createBooking() из booking.js —
// поэтому защита от овербукинга (EXCLUDE constraint в БД) работает одинаково
// для брони и через сайт, и через WhatsApp-чат.
// ============================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createBooking } = require('./booking.js');
const { sendGreenApiMessage } = require('./whatsapp.js');
const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Категории на сайте (ROOM_TYPES во фронтенде: 'standard' | 'deluxe' | 'family')
// -> тип номера в таблице rooms (как используется в index.js для WhatsApp-бота)
const CATEGORY_TO_ROOM_TYPE = {
    standard: 'standard',
    deluxe: 'deluxe',
    family: 'suite',
};

const CATEGORY_LABELS = {
    standard: 'Стандарт',
    deluxe: 'Делюкс',
    family: 'Семейный',
};

/**
 * Ищет первый свободный номер указанного типа на заданные даты.
 * Логика идентична той, что уже используется в index.js для бронирований
 * через WhatsApp — вынесена сюда, чтобы не дублировать код.
 */
async function findAvailableRoom(roomType, checkIn, checkOut) {
    const { data: allRooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id, room_number')
        .eq('type', roomType)
        .eq('is_active', true);

    if (roomsError || !allRooms || allRooms.length === 0) {
        return null;
    }

    for (const room of allRooms) {
        const { data: conflicts } = await supabase
            .from('bookings')
            .select('id')
            .eq('room_id', room.id)
            .eq('status', 'confirmed')
            .lt('check_in', checkOut)
            .gt('check_out', checkIn);

        if (!conflicts || conflicts.length === 0) {
            return room; // нашли свободный номер этой категории
        }
    }

    return null; // все номера этой категории заняты на выбранные даты
}

async function notifyAdminAboutSiteBooking({ name, phone, category, checkIn, checkOut, roomNumber }) {
    if (!ADMIN_PHONE) {
        console.log('⚠️ ADMIN_PHONE не задан — уведомление администратору не отправлено.');
        return;
    }

    const text =
        `🌐 НОВАЯ БРОНЬ С САЙТА — "Гранд Вилла"\n\n` +
        `🚪 Номер комнаты: ${roomNumber}\n` +
        `👤 Имя: ${name}\n` +
        `📞 Телефон: ${phone}\n` +
        `🛏 Категория: ${CATEGORY_LABELS[category] || category}\n` +
        `📅 Заезд: ${checkIn}\n` +
        `📅 Выезд: ${checkOut}\n\n` +
        `Пожалуйста, подтвердите бронь и свяжитесь с гостем.`;

    console.log(`📨 Отправляю уведомление админу о брони с сайта: ${ADMIN_PHONE}`);
    await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, text);
}

/**
 * POST /api/bookings
 * Body: { name, phone, category, check_in, check_out }
 * Именно этот формат шлёт форма бронирования на сайте (GrandVillaPortal.jsx)
 */
router.post('/api/bookings', async (req, res) => {
    try {
        const { name, phone, category, check_in, check_out } = req.body;

        if (!name || !phone || !category || !check_in || !check_out) {
            return res.status(400).json({
                success: false,
                error: 'Заполните все поля.',
            });
        }

        if (new Date(check_out) <= new Date(check_in)) {
            return res.status(400).json({
                success: false,
                error: 'Дата выезда должна быть позже даты заезда.',
            });
        }

        const roomType = CATEGORY_TO_ROOM_TYPE[category];
        if (!roomType) {
            return res.status(400).json({
                success: false,
                error: `Неизвестная категория номера: ${category}`,
            });
        }

        // --- Шаг 1: ищем свободный номер этой категории ---
        const availableRoom = await findAvailableRoom(roomType, check_in, check_out);

        if (!availableRoom) {
            return res.status(409).json({
                success: false,
                error: 'Этот номер уже забронирован на выбранные даты. Попробуйте другие даты или категорию.',
            });
        }

        // --- Шаг 2: создаём бронь через уже существующую защищённую функцию ---
        const bookingResult = await createBooking({
            roomId: availableRoom.id,
            guestName: name,
            guestPhone: phone,
            checkIn: check_in,
            checkOut: check_out,
        });

        if (!bookingResult.success) {
            // createBooking() сам ловит гонку состояний (EXCLUDE constraint в БД) —
            // если сообщение об этом, тоже возвращаем 409, а не 500
            const isOverbooking = /забронирован|занят/i.test(bookingResult.error || '');
            return res.status(isOverbooking ? 409 : 500).json({
                success: false,
                error: bookingResult.error,
            });
        }

        // --- Шаг 3: уведомляем администратора (не роняем ответ гостю, если WhatsApp не отправился) ---
        try {
            await notifyAdminAboutSiteBooking({
                name,
                phone,
                category,
                checkIn: check_in,
                checkOut: check_out,
                roomNumber: availableRoom.room_number,
            });
        } catch (notifyError) {
            console.error('Бронь сохранена, но уведомление в WhatsApp не отправлено:', notifyError.message);
        }

        return res.status(200).json({
            success: true,
            booking: bookingResult.booking,
        });

    } catch (err) {
        console.error('Непредвиденная ошибка в /api/bookings:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Внутренняя ошибка сервера.',
        });
    }
});

module.exports = router;
