---
title: "Хранилище Linux: файловые системы, LVM, RAID, ZFS и Ceph"
description: "Практическая памятка администратора: диагностика стека хранения, выбор технологии, расширение разделов и LVM, перенос swap и мониторинг."
pubDate: 2026-05-12
tags: ["linux", "storage", "LVM", "ZFS", "Ceph", "файловые системы"]
---

Когда на Linux-сервере заканчивается место, `df -h` показывает только верхушку конструкции. Под файловой системой могут находиться LVM, шифрование, программный RAID, виртуальный диск, сетевой LUN или ZFS. Поэтому перед изменениями сначала восстанавливаем всю цепочку хранения, а затем расширяем ее снизу вверх.

Ниже — памятка по основным актуальным технологиям: как определить текущую схему, чем отличаются варианты и какие команды нужны в типовых ситуациях.

> Перед изменением таблицы разделов, уменьшением томов или заменой дисков проверяем резервную копию и доступ к консоли. Snapshot гипервизора полезен, но не всегда заменяет независимый backup.

## Карта уровней хранения

```text
Физический диск / SAN LUN / виртуальный диск
  ↓
GPT или MBR
  ↓
Раздел или весь диск
  ↓
mdraid / LUKS / LVM / ZFS / Btrfs / Ceph
  ↓
ext4 / XFS / Btrfs / ZFS
  ↓
Точка монтирования
  ↓
Приложение
```

Примеры:

```text
/dev/sda2 → ext4 → /
/dev/sda3 → LVM PV → VG → LV → XFS → /var
/dev/sda1 + /dev/sdb1 → mdraid RAID1 → LVM → ext4
/dev/sda3 + /dev/sdb3 → ZFS mirror → datasets/zvol
Ceph OSD → RADOS → RBD → диск VM → LVM → ext4
```

Технологии разных уровней нельзя сравнивать напрямую:

- ext4 и XFS — файловые системы;
- LVM — менеджер блочных томов;
- mdadm — программный RAID;
- LUKS — шифрование;
- ZFS и Btrfs совмещают несколько функций;
- Ceph — распределенная система хранения;
- NFS и SMB дают сетевой доступ к файлам;
- iSCSI передает по сети блочное устройство.

## Быстрая инвентаризация

```bash
lsblk -e7 -o NAME,PATH,SIZE,TYPE,FSTYPE,FSVER,MOUNTPOINTS,UUID,MODEL
blkid
findmnt
df -hT
df -ih
fdisk -l
swapon --show
```

Специализированные команды:

```bash
# LVM
pvs
vgs
lvs -a -o +devices

# mdraid
cat /proc/mdstat
mdadm --detail --scan
mdadm --detail /dev/md0

# ZFS
zpool status -P
zpool list
zfs list -o name,used,avail,refer,mountpoint

# Btrfs
btrfs filesystem show
btrfs filesystem usage /
btrfs device stats /

# LUKS
cryptsetup status <mapper-name>

# SMART
smartctl -x /dev/sda
```

## Как читать `lsblk`

Обычный раздел:

```text
sda       100G disk
├─sda1      1G part vfat /boot/efi
└─sda2     99G part ext4 /
```

LVM:

```text
sda                100G disk
└─sda3              99G part LVM2_member
  ├─vg0-root        40G lvm  ext4 /
  ├─vg0-var         50G lvm  xfs  /var
  └─vg0-swap         8G lvm  swap [SWAP]
```

Шифрование и LVM:

```text
sda3                    100G part crypto_LUKS
└─crypt-system          100G crypt LVM2_member
  ├─vg0-root             80G lvm ext4 /
  └─vg0-swap              8G lvm swap
```

Для ZFS одного `lsblk` недостаточно: связи между дисками смотрим через `zpool status`, а datasets и zvol — через `zfs list`.

## GPT и MBR

GPT — основной вариант для современных систем: большие диски, UEFI, много разделов и резервная таблица в конце устройства.

```text
1M     BIOS boot
512M   EFI System
остальное Linux filesystem/LVM/ZFS
```

MBR ограничен дисками примерно до 2 ТБ и четырьмя primary partitions. Для дополнительных разделов используется extended partition:

```text
sda1  Linux
sda2  Extended
└─sda5 Swap
```

Такая схема часто создает проблему, когда swap мешает расширить корневой раздел.

## Локальные файловые системы

### ext4

Универсальный вариант для Linux-серверов и VM: зрелая реализация, онлайн-расширение, умеренные требования к ресурсам и понятные средства восстановления. Уменьшение возможно только в offline-режиме.

```bash
resize2fs /dev/vg0/root
e2fsck -f /dev/vg0/root
```

`e2fsck` не запускают на смонтированной файловой системе в режиме записи.

### XFS

Хорошо подходит для больших файловых систем, параллельного I/O, журналов, баз и данных приложений. Онлайн-расширение выполняется по точке монтирования:

```bash
xfs_growfs /var
xfs_repair -n /dev/vg0/var
```

Главное ограничение: XFS нельзя штатно уменьшить.

### Btrfs

CoW-файловая система с subvolumes, snapshots, checksums, сжатием, reflink, send/receive и поддержкой нескольких устройств.

```bash
btrfs filesystem show
btrfs filesystem usage /data
btrfs device stats /data
btrfs scrub status /data
btrfs filesystem resize max /data
btrfs subvolume snapshot -r /data /snapshots/data-$(date +%F)
```

Для баз, образов VM и других активно изменяемых файлов нужно учитывать влияние CoW и фрагментации. RAID5/6 требует отдельного изучения текущих ограничений.

### ZFS

ZFS совмещает управление дисками, программный RAID и файловую систему. Основные возможности: checksums, self-healing, mirror/RAIDZ, datasets, zvol, snapshots, clones, compression и send/receive.

```text
pool    — пул хранения
vdev    — группа устройств
dataset — файловая система ZFS
zvol    — блочное устройство
```

Пример:

```text
sda + sdb
  → mirror vdev
  → rpool
     ├─ rpool/ROOT
     ├─ rpool/data
     └─ rpool/backup
```

```bash
zpool status -v
zpool list
zpool iostat -v 5
zfs list
zfs get all <dataset>
zfs snapshot rpool/data@before-upgrade
zfs set compression=zstd rpool/data
```

ZFS mirror не является backup. Свободное место datasets обычно общее, поэтому значения `Avail` из нескольких строк `df` нельзя складывать. Дедупликацию не включают без расчета памяти и подтвержденной потребности.

### Другие файловые системы

**bcachefs** — новая CoW-файловая система с checksums, compression, snapshots и несколькими устройствами. Перед критичным применением проверяем поддержку дистрибутивом, версию ядра и средства восстановления.

**F2FS** ориентирована на flash, eMMC и embedded-системы. На обычном сервере чаще выбирают ext4, XFS или ZFS.

**tmpfs** хранит данные в памяти с возможностью вытеснения в swap:

```bash
mount -t tmpfs -o size=2G tmpfs /mnt/ram
```

**OverlayFS** объединяет read-only и изменяемый слои контейнера. Это слой поверх основной файловой системы, а не ее замена.

## LVM

```text
PV → VG → LV
```

Создание:

```bash
pvcreate /dev/sdb
vgcreate vgdata /dev/sdb
lvcreate -n data -L 500G vgdata
mkfs.xfs /dev/vgdata/data
```

Добавление диска и расширение:

```bash
pvcreate /dev/sdc
vgextend vgdata /dev/sdc
lvextend -r -L +100G /dev/vgdata/data
```

Все свободное место VG:

```bash
lvextend -r -l +100%FREE /dev/vgdata/data
```

LVM удобен для независимо растущих `/var`, `/home`, каталогов баз и контейнеров. Сам по себе он не предоставляет checksums, backup или отказоустойчивость.

### LVM Thin и snapshots

Thin pool позволяет создавать логические тома, виртуальный размер которых превышает фактически занятое место.

```bash
lvs -a -o lv_name,lv_size,data_percent,metadata_percent
```

Контролировать нужно `Data%` и `Metadata%`: переполнение thin pool может затронуть все размещенные в нем тома.

Обычный snapshot:

```bash
lvcreate -s -n data-snap -L 20G /dev/vg0/data
```

Он не является backup и станет непригоден после переполнения выделенного пространства.

**Stratis** — управляющий слой над device-mapper, thin provisioning и XFS, прежде всего для RHEL-подобных систем. **VDO** предоставляет блочное сжатие, дедупликацию и thin provisioning, но требует контроля физического заполнения и расходов CPU/RAM.

## mdadm

Классическая схема:

```text
sda1 + sdb1 → /dev/md0 RAID1 → LVM → ext4/XFS
```

```bash
cat /proc/mdstat
mdadm --detail /dev/md0
```

| Уровень | Минимум дисков | Назначение |
|---|---:|---|
| RAID0 | 2 | Производительность без защиты |
| RAID1 | 2 | Зеркало |
| RAID5 | 3 | Одна отказоустойчивая четность |
| RAID6 | 4 | Двойная четность |
| RAID10 | 4 | Зеркала и высокая производительность |

Для крупных HDD RAID10 или RAID6 часто безопаснее RAID5 из-за длительного rebuild и риска второго сбоя.

## LUKS

```text
раздел → LUKS → ext4
раздел → LUKS → LVM → ext4/XFS
mdraid → LUKS → LVM
```

```bash
cryptsetup status cryptdata
cryptsetup luksDump /dev/sdb1
cryptsetup luksHeaderBackup /dev/sdb1 \
  --header-backup-file luks-header.img
```

Копию заголовка и ключи хранят отдельно. Для серверов заранее планируют разблокировку после перезагрузки и содержимое initramfs.

## Сетевые и распределенные хранилища

**NFS** — стандартный файловый доступ Linux/Unix, удобный для backup, ISO, шаблонов и общих каталогов:

```bash
mount -t nfs4 nas:/backup /mnt/backup
```

**SMB/CIFS** обычно используют для интеграции с Windows:

```bash
mount -t cifs //server/share /mnt/share \
  -o credentials=/root/.smb-credentials
```

Пароль не указывают непосредственно в командной строке или открытом `/etc/fstab`.

**iSCSI** предоставляет удаленный LUN как блочное устройство. Поверх него создают LVM или файловую систему. Для нескольких путей используют multipath:

```bash
multipath -ll
```

Обычную ext4 или XFS нельзя одновременно монтировать на нескольких узлах в режиме записи.

### Ceph

```text
RBD    → блочные диски VM
CephFS → общая POSIX-файловая система
RGW    → объектное S3/Swift-хранилище
```

Ceph RBD особенно актуален для кластеров Proxmox: гипервизоры получают совместный доступ к дискам VM, а Ceph реплицирует и перераспределяет данные между OSD.

Преимущества — отсутствие единой центральной СХД, snapshots, clones, live migration и горизонтальное расширение. Цена — сложность, требования к сети, нескольким узлам и правильному sizing. Для одного Proxmox-сервера Ceph обычно избыточен.

## Расширение: типовые сценарии

Обычный ext4-раздел:

```bash
growpart -N /dev/sda 2
growpart /dev/sda 2
resize2fs /dev/sda2
```

XFS:

```bash
growpart -N /dev/sda 2
growpart /dev/sda 2
xfs_growfs /
```

LVM внутри раздела:

```bash
growpart -N /dev/sda 3
growpart /dev/sda 3
pvresize /dev/sda3
vgs
lvextend -r -L +20G /dev/vg0/root
```

Новый диск в VG:

```bash
pvcreate /dev/sdb
vgextend vg0 /dev/sdb
lvextend -r -L +100G /dev/vg0/data
```

Btrfs после увеличения устройства:

```bash
btrfs filesystem resize max /data
```

ZFS mirror при переходе на диски большего размера:

```text
заменить первый диск
→ дождаться resilver
→ проверить ONLINE
→ заменить второй диск
→ дождаться resilver
→ расширить pool
```

```bash
zpool status
zpool online -e <pool> <device>
```

Имена устройств берем из `zpool status -P`, предпочтительно в виде `/dev/disk/by-id/...`.

## Виртуальная машина Proxmox

На гипервизоре:

```bash
qm config <VMID>
qm resize <VMID> scsi0 +50G
```

В гостевой системе:

```bash
lsblk
```

Дальше применяется один из вариантов:

```text
growpart → resize2fs
growpart → xfs_growfs
growpart → pvresize → lvextend -r
```

Устройства `/dev/zd*` на ZFS-хосте являются zvol виртуальных машин. Изменять их разметку на работающей VM с хоста не следует.

## Swap в конце диска

Проблемная MBR-схема:

```text
sda1  root
sda2  extended
└─sda5 swap
свободное место
```

Рабочая последовательность:

```text
создать swap-файл
→ включить его
→ отключить старый swap
→ убрать старый swap из fstab
→ удалить sda5 и пустой sda2
→ расширить sda1
→ расширить файловую систему
```

Для ext4 или XFS:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
```

`/etc/fstab`:

```text
/swapfile none swap defaults 0 0
```

```bash
swapon --show
free -h
swapoff /dev/sda5
```

Если использовался `resume`, старый UUID удаляют из конфигурации загрузки и пересобирают initramfs. После удаления старых swap-разделов:

```bash
growpart /dev/sda 1
resize2fs /dev/sda1
```

Для XFS последняя команда — `xfs_growfs /`. Для Btrfs swap-файл создается по специальным правилам Btrfs.

## Пример Proxmox на ZFS mirror

```text
sda
├─sda1  BIOS boot
├─sda2  EFI System
└─sda3  ZFS member

sdb
├─sdb1  BIOS boot
├─sdb2  EFI System
└─sdb3  ZFS member
```

```text
rpool
└─mirror-0
  ├─sda3
  └─sdb3

rpool/ROOT/pve-1  → /
rpool/var-lib-vz  → /var/lib/vz
rpool/data        → VM и LXC
```

Хранилища Proxmox:

```text
local     → /var/lib/vz → rpool/var-lib-vz
local-zfs → rpool/data
```

`local` и `local-zfs` — разные storage ID, но используют свободное место одного `rpool`. Их емкость нельзя складывать.

```bash
pvesm status
zpool list
zfs list
```

Обычный `Linux by Zabbix agent` может не обнаружить `local-zfs`, поскольку это `zfspool`, а не обычная смонтированная файловая система. Для Proxmox используют `Proxmox VE by HTTP` с обнаружением storage через API:

```bash
pvesh get /nodes/<PVE_NODE>/storage --output-format json-pretty
```

В Zabbix отдельно контролируют доступность `local` и `local-zfs`, а физическую емкость и здоровье — по `rpool`.

## Что мониторить

| Уровень | Основные показатели |
|---|---|
| Диски | SMART health, температура, reallocated/pending/uncorrectable, self-test |
| mdraid | degraded, число активных дисков, recovery/resync, mismatch count |
| LVM | наличие PV, VG free, состояние LV, snapshots |
| LVM Thin | Data%, Metadata% |
| Файловая система | bytes, inodes, read-only remount, I/O errors, latency |
| ZFS | pool/vdev health, READ/WRITE/CKSUM delta, capacity, scrub, resilver |
| Btrfs | device errors, data/metadata usage, scrub, read-only state |
| Ceph | health, quorum, OSD up/in, PG states, nearfull/full, recovery, latency |

Ориентировочные пороги заполнения:

```text
75% — warning
85% — high
90–95% — disaster
```

Для ZFS и thin pool предупреждение поднимают раньше, чем для обычного ext4.

Минимальная проверка ZFS:

```bash
zpool status -x
```

Норма:

```text
all pools are healthy
```

Мониторинга гипервизора недостаточно. В гостевых системах отдельно контролируют `/`, `/var`, inodes, VG free, thin pool и swap. Хост видит размер zvol, но не знает, сколько места осталось внутри гостевой ext4.

## Что выбирать

| Задача | Практический выбор |
|---|---|
| Простая Linux VM | ext4 |
| Большой `/var` или данные приложения | XFS |
| Несколько растущих mountpoints | LVM + ext4/XFS |
| Локальные snapshots и subvolumes | Btrfs |
| Один Proxmox или NAS | ZFS |
| Классический RAID без ZFS | mdadm + LVM + ext4/XFS |
| Шифрование | LUKS + LVM + ext4/XFS |
| Proxmox-кластер | Ceph RBD |
| Общий Linux-каталог | NFS |
| Windows-совместимый ресурс | SMB |
| SAN LUN | iSCSI + multipath + LVM |
| S3-совместимое хранение | Ceph RGW или другое object storage |
| Flash/embedded | F2FS |
| Новая CoW-ФС для лаборатории | bcachefs после проверки поддержки |

## Опасные операции

Особого внимания требуют:

```text
уменьшение раздела или LV
изменение начала раздела
любая попытка уменьшить XFS
удаление extended-разделов
переполнение LVM Thin
переполнение ZFS pool
zpool add вместо zpool attach
изменение zvol работающей VM с хоста
```

Перед изменениями снова собираем состояние:

```bash
lsblk -f
findmnt
blkid
pvs
vgs
lvs -a -o +devices
zpool status -P
zfs list
```

Главный принцип:

```text
Сначала определить все слои хранения.
Потом изменять их по порядку снизу вверх.
```

Если виртуальный диск увеличен, это еще не означает, что автоматически увеличились раздел, PV, LV и файловая система.

## Полезная документация

- [Btrfs documentation](https://btrfs.readthedocs.io/en/latest/Introduction.html)
- [OpenZFS: scrub and resilver](https://openzfs.github.io/openzfs-docs/Basic%20Concepts/Operations/Scrub%20and%20Resilver.html)
- [Red Hat: управление LVM](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/configuring_and_managing_logical_volumes/basic-logical-volume-management)
- [Ceph architecture](https://docs.ceph.com/en/latest/architecture/)
- [CephFS documentation](https://docs.ceph.com/en/latest/cephfs/)
- [Zabbix: Proxmox VE by HTTP](https://www.zabbix.com/integrations/proxmox)
