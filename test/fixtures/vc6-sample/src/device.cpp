#include "globals.h"

typedef void (*Callback)(void);

static Callback g_callback = 0;

void DevicePump(void)
{
    if (g_callback) {
        (*g_callback)();
    }
}
