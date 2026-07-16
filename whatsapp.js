// ============================================================
// whatsapp.js
// Общий модуль отправки сообщений через Green API.
// Вынесен отдельно, чтобы им могли пользоваться и index.js
// (диалоги с гостями), и orders_api.js (уведомления о QR-заказах),
// и любые другие модули в будущем — без дублирования кода.
// ============================================================

const axios = require('axios');

const GREEN_API_URL = process.env.GREEN_API_URL || 'https://7107.api.greenapi.com';
const ID_INSTANCE = process.env.GREEN_ID_INSTANCE;
const API_TOKEN_INSTANCE = process.env.GREEN_API_TOKEN_INSTANCE;
const ADMIN_PHONE = process.env.ADMIN_PHONE;

/**
 * Отправляет текстовое сообщение через Green API.
 * @param {string} chatId - например '77074541696@c.us'
 * @param {string} text
 */
async function sendGreenApiMessage(chatId, text) {
    if (!text) return;

    if (!ID_INSTANCE || !API_TOKEN_INSTANCE) {
        console.error('❌ GREEN_ID_INSTANCE / GREEN_API_TOKEN_INSTANCE не заданы в .env — сообщение не отправлено.');
        return;
    }

    try {
        const url = `${GREEN_API_URL}/waInstance${ID_INSTANCE}/sendMessage/${API_TOKEN_INSTANCE}`;
        const response = await axios.post(url, { chatId, message: text }, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`✅ Green API ответ на отправку: ${response.status}`);
    } catch (err) {
        console.error('❌ Ошибка отправки в Green API:', JSON.stringify(err.response?.data || err.message));
    }
}

/**
 * Уведомляет администратора о новом заказе рум-сервиса по QR.
 * Используется из orders_api.js.
 * @param {object} order - строка из таблицы orders (room_number, service_type, details, id)
 */
async function notifyAdminAboutOrder(order) {
    if (!ADMIN_PHONE) {
        console.log('⚠️ ADMIN_PHONE не задан в .env — уведомление о заказе не отправлено.');
        return;
    }

    const text =
        `🛎 НОВЫЙ ЗАКАЗ РУМ-СЕРВИСА\n\n` +
        `🚪 Номер: ${order.room_number}\n` +
        `🧾 Услуга: ${order.service_type}\n` +
        `📝 Детали: ${order.details || '—'}\n` +
        `🆔 ID заказа: ${order.id}`;

    await sendGreenApiMessage(`${ADMIN_PHONE}@c.us`, text);
}

module.exports = { sendGreenApiMessage, notifyAdminAboutOrder };
