package com.spilivere.app;

/** Reads DownloadManager IDs from Capacitor's JSON bridge values. */
final class DownloadIdParser {
    private static final double MAX_SAFE_INTEGER = 9007199254740991d;

    private DownloadIdParser() {}

    static long parse(Object value) {
        if (value instanceof Byte || value instanceof Short
                || value instanceof Integer || value instanceof Long) {
            long id = ((Number) value).longValue();
            return id >= 0 ? id : -1L;
        }

        if (value instanceof Number) {
            double numericId = ((Number) value).doubleValue();
            if (Double.isNaN(numericId) || Double.isInfinite(numericId) || numericId < 0
                    || numericId > MAX_SAFE_INTEGER || numericId != Math.rint(numericId)) {
                return -1L;
            }
            return (long) numericId;
        }

        if (value instanceof String) {
            try {
                long id = Long.parseLong(((String) value).trim());
                return id >= 0 ? id : -1L;
            } catch (NumberFormatException ignored) {
                return -1L;
            }
        }

        return -1L;
    }
}
