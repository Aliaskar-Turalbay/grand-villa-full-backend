// ============================================================
// booking.js
// Модуль создания бронирований с двойной защитой от овербукинга:
//   1) Проверка на уровне приложения (быстрый, понятный отказ)
//   2) EXCLUDE constraint на уровне БД (последний рубеж защиты,
//      страхует от гонки состояний при параллельных запросах)
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// Используем service_role ключ, т.к. это доверенный backend
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Код ошибки Postgres для нарушения EXCLUDE constraint
const POSTGRES_EXCLUSION_VIOLATION = '23P01';

/**
 * Проверяет пересечение двух диапазонов дат.
 * Пересечение есть, если: (НовыйЗаезд < СуществующийВыезд) И (НовыйВыезд > СуществующийЗаезд)
 *
 * @param {string|Date} newCheckIn
 * @param {string|Date} newCheckOut
 * @param {string|Date} existingCheckIn
 * @param {string|Date} existingCheckOut
 * @returns {boolean}
 */
function datesOverlap(newCheckIn, newCheckOut, existingCheckIn, existingCheckOut) {
    const nIn = new Date(newCheckIn);
    const nOut = new Date(newCheckOut);
    const eIn = new Date(existingCheckIn);
    const eOut = new Date(existingCheckOut);

    return nIn < eOut && nOut > eIn;
}

/**
 * Создает новую бронь, если номер свободен на указанные даты.
 *
 * @param {Object} params
 * @param {number} params.roomId       - ID номера (rooms.id)
 * @param {string} params.guestName    - Имя гостя
 * @param {string} params.guestPhone   - Телефон гостя
 * @param {string} params.checkIn      - Дата заезда, формат 'YYYY-MM-DD'
 * @param {string} params.checkOut     - Дата выезда, формат 'YYYY-MM-DD'
 * @returns {Promise<{success: boolean, booking?: object, error?: string}>}
 */
async function createBooking({ roomId, guestName, guestPhone, checkIn, checkOut }) {
    // --- Базовая валидация входных данных ---
    if (!roomId || !guestName || !guestPhone || !checkIn || !checkOut) {
        return { success: false, error: 'Не заполнены обязательные поля.' };
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);

    if (isNaN(checkInDate) || isNaN(checkOutDate)) {
        return { success: false, error: 'Некорректный формат даты.' };
    }

    if (checkOutDate <= checkInDate) {
        return { success: false, error: 'Дата выезда должна быть позже даты заезда.' };
    }

    // --- Шаг 1: Проверяем, что номер существует и активен ---
    const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('id, is_active')
        .eq('id', roomId)
        .single();

    if (roomError || !room) {
        return { success: false, error: 'Номер не найден.' };
    }

    if (!room.is_active) {
        return { success: false, error: 'Номер временно недоступен для бронирования.' };
    }

    // --- Шаг 2: Прикладная проверка пересечений (быстрый предварительный отказ) ---
    // Забираем все подтвержденные брони этого номера, которые потенциально
    // могут пересекаться с запрашиваемым диапазоном.
    const { data: existingBookings, error: fetchError } = await supabase
        .from('bookings')
        .select('id, check_in, check_out')
        .eq('room_id', roomId)
        .eq('status', 'confirmed')
        .lt('check_in', checkOut)   // существующий заезд < нового выезда
        .gt('check_out', checkIn);  // существующий выезд > нового заезда

    if (fetchError) {
        return { success: false, error: 'Ошибка при проверке доступности номера.' };
    }

    if (existingBookings && existingBookings.length > 0) {
        // Двойная проверка через JS-функцию для наглядности и отладки
        const conflict = existingBookings.find(b =>
            datesOverlap(checkIn, checkOut, b.check_in, b.check_out)
        );
        if (conflict) {
            return {
                success: false,
                error: `Номер уже забронирован на пересекающиеся даты (бронь #${conflict.id}).`
            };
        }
    }

    // --- Шаг 3: Пытаемся вставить бронь. ---
    // Даже если между шагом 2 и шагом 3 кто-то параллельно создал
    // конфликтующую бронь (race condition), EXCLUDE constraint в БД
    // отклонит вставку — это и есть "жесткая" защита.
    const { data: newBooking, error: insertError } = await supabase
        .from('bookings')
        .insert({
            room_id: roomId,
            guest_name: guestName,
            guest_phone: guestPhone,
            check_in: checkIn,
            check_out: checkOut,
            status: 'confirmed'
        })
        .select()
        .single();

    if (insertError) {
        // Ловим именно нарушение constraint'а на пересечение дат
        if (insertError.code === POSTGRES_EXCLUSION_VIOLATION) {
            return {
                success: false,
                error: 'Номер только что был забронирован другим гостем на эти даты. Попробуйте другие даты.'
            };
        }
        return { success: false, error: `Ошибка при создании брони: ${insertError.message}` };
    }

    return { success: true, booking: newBooking };
}

module.exports = { createBooking, datesOverlap };