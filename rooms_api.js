// ============================================================
// rooms_api.js
// Отдаёт реальную занятость номеров из Supabase.
// "Занят" = есть подтверждённая бронь (status='confirmed'),
// которая покрывает СЕГОДНЯШНЮЮ дату (check_in <= сегодня < check_out).
//
// Используется:
//   1) фронтендом сайта — чтобы показывать 🟢 Свободен / 🔴 Занят
//   2) WhatsApp-ботом Алией (index.js) — чтобы ИИ знал текущую занятость
//      прямо во время диалога с гостем
// ============================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Возвращает массив [{ room_number, type, is_available }] для всех активных номеров.
 * Общая функция — переиспользуется и роутом ниже, и index.js (WhatsApp-ботом).
 */
async function getRoomsAvailability() {
    const today = new Date().toISOString().split('T')[0];

    const { data: rooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id, room_number, type')
        .eq('is_active', true);

    if (roomsError) {
        throw new Error(`Не удалось получить список номеров: ${roomsError.message}`);
    }

    const { data: activeBookings, error: bookingsError } = await supabase
        .from('bookings')
        .select('room_id')
        .eq('status', 'confirmed')
        .lte('check_in', today)
        .gt('check_out', today);

    if (bookingsError) {
        throw new Error(`Не удалось получить занятость номеров: ${bookingsError.message}`);
    }

    const occupiedRoomIds = new Set((activeBookings || []).map((b) => b.room_id));

    return (rooms || []).map((room) => ({
        room_number: room.room_number,
        type: room.type,
        is_available: !occupiedRoomIds.has(room.id),
    }));
}

/**
 * GET /api/rooms/availability
 * Публичный эндпоинт для фронтенда сайта.
 */
router.get('/api/rooms/availability', async (req, res) => {
    try {
        const availability = await getRoomsAvailability();
        return res.status(200).json({ success: true, rooms: availability });
    } catch (err) {
        console.error('Ошибка в /api/rooms/availability:', err.message);
        return res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера.' });
    }
});

// router — это функция (express.Router()), поэтому можно и подключать через app.use(...),
// и одновременно дёргать getRoomsAvailability() напрямую из других файлов (например, index.js).
module.exports = router;
module.exports.getRoomsAvailability = getRoomsAvailability;
