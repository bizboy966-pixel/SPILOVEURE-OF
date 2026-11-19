package com.spilivere.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class DownloadIdParserTest {
    @Test
    public void acceptsSmallJsonIntegerIdsFromCapacitor() {
        assertEquals(7L, DownloadIdParser.parse(Integer.valueOf(7)));
    }

    @Test
    public void acceptsLongAndIntegralDoubleIds() {
        assertEquals(2147483648L, DownloadIdParser.parse(Long.valueOf(2147483648L)));
        assertEquals(42L, DownloadIdParser.parse(Double.valueOf(42.0)));
    }

    @Test
    public void acceptsNumericStringIds() {
        assertEquals(31L, DownloadIdParser.parse(" 31 "));
    }

    @Test
    public void rejectsMissingNegativeFractionalAndUnsafeIds() {
        assertEquals(-1L, DownloadIdParser.parse(null));
        assertEquals(-1L, DownloadIdParser.parse(-1));
        assertEquals(-1L, DownloadIdParser.parse(2.5));
        assertEquals(-1L, DownloadIdParser.parse(Double.NaN));
        assertEquals(-1L, DownloadIdParser.parse(9007199254740992d));
        assertEquals(-1L, DownloadIdParser.parse("not-an-id"));
    }
}
