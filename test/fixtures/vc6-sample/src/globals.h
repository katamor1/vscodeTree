#ifndef GLOBALS_H
#define GLOBALS_H

extern volatile int g_counter;
extern int g_mode;
extern int g_interruptFlag;
extern int g_buffer[8];

void CommonUpdate(void);
unsigned long WorkerThread(void *param);
void MonitorThread(void);
void InterruptHandler(void);
void PointerAlias(void);

#endif
