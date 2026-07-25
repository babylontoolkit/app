#if UNITY_EDITOR
﻿using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using UnityEditor;

namespace UnityEngine
{
#pragma warning disable CS0649

    [Serializable] internal enum Plan { Indie = 0, SmallBusiness = 1, PremiumContent = 2, EnterprisePartner = 3 }

    [Serializable] internal class License { public string licensee; public string product; public string project; public string secret; public bool trial; public string plan; public string org; public string key; public string s1; public string s2; }

    [Serializable] internal class Subscription { public string id; public string plan; public string start; public string email; public string status; }

#pragma warning restore CS0649

    internal class LicenseData
    {
        private readonly string licensee;
        private readonly string plan;
        private readonly string org;
        private readonly string tag;
        private readonly string expires;
        private readonly string product;
        private readonly string project;
        private readonly string license;
        private readonly string seat1;
        private readonly string seat2;

        internal LicenseData(string p, string l, string o, string t, string e, string product, string project, string key, string s1, string s2)
        {
            this.licensee = l;
            this.plan = p;
            this.org = o;
            this.tag = t;
            this.expires = e;
            this.product = product;
            this.project = project;
            this.license = key;
            this.seat1 = s1;
            this.seat2 = s2;
        }
        public string GetLicensee()
        {
            return this.licensee;
        }
        public string GetPlan()
        {
            return this.plan;
        }
        public string GetOrg()
        {
            return this.org;
        }
        public string GetTag()
        {
            return this.tag;
        }
        public string GetExpires()
        {
            return this.expires;
        }
        public string GetProduct()
        {
            return this.product;
        }
        public string GetProject()
        {
            return this.project;
        }
        public string GetKey()
        {
            return this.license;
        }
        public string GetSeatOne()
        {
            return this.seat1;
        }
        public string GetSeatTwo()
        {
            return this.seat2;
        }
    }

    public static class ToolkitManager
    {
        private const string CANVAS_TOOLS_OWNERS = "mackeyk24@gmail.com, mackeykinard@gmail.com";
        private const string CANVAS_TOOLS_CONFIG = "[Config]";
        internal static LicenseData LicenseObject = null;

        // This constant is used to determine the keysize of the encryption algorithm
        private static int GetKeySize() { return 256; }
        // This constant is used to determine the keysize of the encryption algorithm
        // [DllImport("YourDLL")] private static extern string Internal_GetKeyPhrase();
        private static string GetKeyPhrase() { return "12bucklemyshoe" /*UnityTools.Internal_GetKeyPhrase()*/; }
        // This size of the IV (in bytes) must = (keysize / 8).  Default keysize is 256, so the IV must be
        // 32 bytes long.  Using a 16 character string here gives us 32 bytes when converted to a byte array.
        // [DllImport("YourDLL")] private static extern string Internal_GetInitVector();
        private static string GetInitVector() { return "xdgrq4yhjmd1ajel" /*UnityTools.Internal_GetInitVector()*/; }
        /* YourDLL - TODO: Get Internal Key Phrase From Native Code Native Code
        extern "C" {
            LPTRSTR Internal_GetKeyPhrase() { return "12bucklemyshoe"; }
            LPTRSTR Internal_GetInitVector() { return "xdgrq4yhjmd1ajel"; }
        }*/

        public static bool IsPro()
        {
            bool result = false;
            ToolkitManager.ValidateLicenseKey();
            if (ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetTag()))
            {
                result = (ToolkitManager.LicenseObject.GetTag() == "12bucklemyshoe");
            }
            return result;
        }
        public static bool IsLicensee()
        {
            bool result = false;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetLicensee()))
            {
                result = (ToolkitManager.LicenseObject.GetLicensee().Equals(CloudProjectSettings.userName, StringComparison.OrdinalIgnoreCase));
            }
            return result;
        }
        public static bool IsOrganization()
        {
            bool result = false;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetOrg()))
            {
                result = (ToolkitManager.LicenseObject.GetOrg().Equals(CloudProjectSettings.organizationName, StringComparison.OrdinalIgnoreCase));
            }
            return result;
        }
        public static string GetLicenseOrg()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetOrg()))
            {
                result = ToolkitManager.LicenseObject.GetOrg();
            }
            return result;
        }
        public static string GetLicenseKey()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetKey()))
            {
                result = ToolkitManager.LicenseObject.GetKey();
            }
            return result;
        }
        public static string GetLicenseType()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetPlan()))
            {
                result = ToolkitManager.LicenseObject.GetPlan();
            }
            return result;
        }
        public static string GetLicenseName()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetLicensee()))
            {
                result = ToolkitManager.LicenseObject.GetLicensee();
            }
            return result;
        }
        public static string GetLicenseProduct()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetProduct()))
            {
                result = ToolkitManager.LicenseObject.GetProduct();
            }
            return result;
        }
        public static string GetLicenseProject()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetProject()))
            {
                result = ToolkitManager.LicenseObject.GetProject();
            }
            return result;
        }
        public static string GetExpirationDate()
        {
            string result = System.String.Empty;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null && !String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetExpires()))
            {
                result = ToolkitManager.LicenseObject.GetExpires();
            }
            return result;
        }
        public static bool HasDeveloperSeat()
        {
            bool result1 = false;
            bool result2 = false;
            bool result3 = false;
            if (ToolkitManager.IsPro() && ToolkitManager.LicenseObject != null)
            {
                result1 = (!String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetSeatOne()) && ToolkitManager.LicenseObject.GetSeatOne().Equals(CloudProjectSettings.userName, StringComparison.OrdinalIgnoreCase));
                result2 = (!String.IsNullOrWhiteSpace(ToolkitManager.LicenseObject.GetSeatTwo()) && ToolkitManager.LicenseObject.GetSeatTwo().Equals(CloudProjectSettings.userName, StringComparison.OrdinalIgnoreCase));
                result3 = (ToolkitManager.CANVAS_TOOLS_OWNERS.IndexOf(CloudProjectSettings.userName, StringComparison.OrdinalIgnoreCase) >= 0);
            }
            return (result1 == true || result2 == true || result3 == true);
        }
        public static byte[] MakeSafeWebRequest(string endpoint, string licensee, string devid, string email, string product, string project, string organization)
        {
            System.Net.WebClient webClient = new System.Net.WebClient();
            webClient.Headers["Authorization"] = "Basic " + System.Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes("service:password24"));
            webClient.Headers["Content-Type"] = "application/x-www-form-urlencoded";
            System.Collections.Specialized.NameValueCollection formData = new System.Collections.Specialized.NameValueCollection();
            formData["secret"] = "12bucklemyshoe";
            formData["licensee"] = licensee;
            formData["devid"] = devid;
            formData["email"] = email;
            formData["product"] = product;
            formData["project"] = project;
            formData["organization"] = organization;
            return webClient.UploadValues(endpoint, "POST", formData);
        }
        public static void ValidateLicenseKey()
        {
            string lfile = Path.Combine(UnityEngine.Application.dataPath, ToolkitManager.CANVAS_TOOLS_CONFIG + "/license.json");
            try
            {
                if (ToolkitManager.LicenseObject == null)
                {
                    if (File.Exists(lfile))
                    {
                        string json = File.ReadAllText(lfile);
                        if (!String.IsNullOrWhiteSpace(json))
                        {
                            License lx = Newtonsoft.Json.JsonConvert.DeserializeObject<License>(json);
                            if (lx != null)
                            {
                                // KEEP-FOR-REFERENCE: string content = String.Format("{0}|{1}|{2}|{3}|{4}|{5}", plan.ToString(), company, organization, product, project, expires);
                                // KEEP-FOR-REFERENCE: string content = String.Format("{0}|{1}|{2}|{3}|{4}|{5}", plan.ToString(), licensee, organization, product, project, expires);
                                // KEEP-FOR-REFERENCE: license.secret = SecurityTools.EncryptString(content);
                                string secret = DecryptString(lx.secret);
                                if (!String.IsNullOrWhiteSpace(secret) && secret.IndexOf("|", StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    string[] parts = secret.Split('|');
                                    if (parts != null && parts.Length >= 6)
                                    {
                                        string plan = parts[0];
                                        string licensee = parts[1];
                                        string organization = parts[2];
                                        string product = parts[3];
                                        string project = parts[4];
                                        string expires = parts[5];
                                        string seed = plan.Equals("EnterprisePartner", StringComparison.OrdinalIgnoreCase) ? UnityEditor.PlayerSettings.companyName : UnityEditor.PlayerSettings.productGUID.ToString();
                                        string hash = ComputeProjectLicenseKeyHash((plan + "-" + seed));
                                        if (lx.key.Equals(hash, StringComparison.OrdinalIgnoreCase))
                                        {
                                            ToolkitManager.LicenseObject = new LicenseData(plan, licensee, organization, "12bucklemyshoe", expires, product, project, lx.key, lx.s1, lx.s2);
                                            if (ToolkitManager.IsPro())
                                            {
                                                UnityEngine.Debug.LogFormat("Pro Tools Active: {0} ({1}) ", UnityEditor.PlayerSettings.companyName, lx.key);
                                            }
                                            else
                                            {
                                                UnityEngine.Debug.LogWarning("Invalid Pro Tools License File: " + lfile);
                                            }
                                        }
                                        else
                                        {
                                            UnityEngine.Debug.LogWarning("Invalid Pro Tools License Hash Key: " + lfile);
                                        }
                                    }
                                    else
                                    {
                                        UnityEngine.Debug.LogWarning("Invalid Pro Tools License Secret Format: " + lfile);
                                    }
                                }
                                else
                                {
                                    UnityEngine.Debug.LogWarning("Invalid Pro Tools License Secret Contents: " + lfile);
                                }
                            }
                            else
                            {
                                UnityEngine.Debug.LogWarning("Null Pro Tools License File: " + lfile);
                            }
                        }
                    }
                }
            }
            catch/* (Exception ex)*/
            {
                UnityEngine.Debug.LogWarning("Failed To Read Pro Tools License File: " + lfile);
                //UnityEngine.Debug.LogWarning(ex.Message);
            }
        }
        internal static string EncryptString(string plainText)
        {
            string passPhrase = ToolkitManager.GetKeyPhrase();
            byte[] initVectorBytes = Encoding.UTF8.GetBytes(ToolkitManager.GetInitVector());
            byte[] plainTextBytes = Encoding.UTF8.GetBytes(plainText);
            PasswordDeriveBytes password = new PasswordDeriveBytes(passPhrase, null);
            byte[] keyBytes = password.GetBytes(ToolkitManager.GetKeySize() / 8);
            RijndaelManaged symmetricKey = new RijndaelManaged();
            symmetricKey.Mode = CipherMode.CBC;
            ICryptoTransform encryptor = symmetricKey.CreateEncryptor(keyBytes, initVectorBytes);
            MemoryStream memoryStream = new MemoryStream();
            CryptoStream cryptoStream = new CryptoStream(memoryStream, encryptor, CryptoStreamMode.Write);
            cryptoStream.Write(plainTextBytes, 0, plainTextBytes.Length);
            cryptoStream.FlushFinalBlock();
            byte[] cipherTextBytes = memoryStream.ToArray();
            memoryStream.Close();
            cryptoStream.Close();
            return Convert.ToBase64String(cipherTextBytes);
        }
        internal static string DecryptString(string cipherText)
        {
            string passPhrase = ToolkitManager.GetKeyPhrase();
            byte[] initVectorBytes = Encoding.UTF8.GetBytes(ToolkitManager.GetInitVector());
            byte[] cipherTextBytes = Convert.FromBase64String(cipherText);
            PasswordDeriveBytes password = new PasswordDeriveBytes(passPhrase, null);
            byte[] keyBytes = password.GetBytes(ToolkitManager.GetKeySize() / 8);
            RijndaelManaged symmetricKey = new RijndaelManaged();
            symmetricKey.Mode = CipherMode.CBC;
            ICryptoTransform decryptor = symmetricKey.CreateDecryptor(keyBytes, initVectorBytes);
            MemoryStream memoryStream = new MemoryStream(cipherTextBytes);
            CryptoStream cryptoStream = new CryptoStream(memoryStream, decryptor, CryptoStreamMode.Read);
            byte[] plainTextBytes = new byte[cipherTextBytes.Length];
            int decryptedByteCount = cryptoStream.Read(plainTextBytes, 0, plainTextBytes.Length);
            memoryStream.Close();
            cryptoStream.Close();
            return Encoding.UTF8.GetString(plainTextBytes, 0, decryptedByteCount);
        }
        internal static string ComputeProjectLicenseKeyHash(string seed)
        {
            string privatekey1 = "babylontoolkit.com";
            string privatekey2 = "05.00.00";
            string productIdentifier = (seed.Replace(" ", "_") + "-" + privatekey1.Replace(" ", "_") + "-" + privatekey2.Replace(" ", "_")).ToLower();
            // ..
            // Compute Hash
            // ..
            System.Text.Encoder enc = System.Text.Encoding.Unicode.GetEncoder();
            byte[] unicodeText = new byte[productIdentifier.Length * 2];
            enc.GetBytes(productIdentifier.ToCharArray(), 0, productIdentifier.Length, unicodeText, 0, true);
            MD5 md5 = new MD5CryptoServiceProvider();
            byte[] result = md5.ComputeHash(unicodeText);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < result.Length; i++)
            {
                sb.Append(result[i].ToString("X2"));
            }
            // ..
            // Format License Key
            // ..
            string productIdentifierHash = sb.ToString().Substring(0, 28).ToUpper();
            char[] serialArray = productIdentifierHash.ToCharArray();
            StringBuilder licenseKey = new StringBuilder();
            int j = 0;
            for (int i = 0; i < 28; i++)
            {
                for (j = i; j < 4 + i; j++)
                {
                    licenseKey.Append(serialArray[j]);
                }
                if (j == 28)
                {
                    break;
                }
                else
                {
                    i = (j) - 1;
                    licenseKey.Append("-");
                }
            }
            return licenseKey.ToString();
        }
    }
}


#endif
