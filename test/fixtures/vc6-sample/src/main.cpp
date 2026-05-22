#include "globals.h"

volatile int g_counter = 0;
int g_mode = 0;
int g_interruptFlag = 0;
int g_buffer[8] = {0};

void CommonUpdate(void)
{
    g_mode = g_counter;
}

unsigned long WorkerThread(void *param)
{
    g_counter++;
    CommonUpdate();
    return 0;
}

void MonitorThread(void)
{
    if (g_counter > 10) {
        g_mode = 2;
    }
}

void InterruptHandler(void)
{
    g_interruptFlag = g_counter;
    g_counter = 0;
}

void PointerAlias(void)
{
    int *p = &g_mode;
    *p = 4;
}
